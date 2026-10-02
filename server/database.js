'use strict';

/**
 * SQLite persistence layer.
 *
 * Replaces the flat JSON stores for both player state and accounts. Two
 * tables mirror the two previous files:
 *
 *   accounts(account_id PRIMARY KEY, username UNIQUE, password_hash, characters_json)
 *   players(char_name PRIMARY KEY, state_json)
 *
 * Durability notes, since a crash mid-write is the failure this is meant to
 * remove:
 *   - journal_mode = WAL keeps readers running while a write commits.
 *   - synchronous = FULL fsyncs the WAL on every commit, so an acknowledged
 *     write has reached the disk. NORMAL would only be safe with WAL checks
 *     disabled, which we do not do.
 *   - Every mutation is a single statement inside an implicit transaction, so
 *     a torn or partially applied player state is not representable.
 *   - Writes are serialized through one queue, so two players cannot interleave
 *     read-modify-write on the same connection.
 */

const fs = require('fs');
const path = require('path');

let sqlite3 = null;
try {
    sqlite3 = require('sqlite3');
} catch (error) {
    throw new Error(
        'sqlite3 is required. Install it with "npm install sqlite3" in the server directory. ' +
        `Original error: ${error.message}`
    );
}

const defaultFile = path.join(__dirname, 'data', 'tibia.sqlite');

let db = null;
let writeQueue = Promise.resolve();
const pendingWrites = new Set();

function resolveDbFile() {
    // TIBIA_DB_FILE previously pointed at a .json path. Accept it as the
    // SQLite file so existing deployments and the test harness keep working
    // without configuration changes.
    const configured = process.env.TIBIA_DB_FILE;
    if (!configured) return defaultFile;
    const resolved = path.resolve(configured);
    if (/\.sqlite3?$/i.test(resolved)) return resolved;
    return resolved.replace(/\.json$/i, '') + '.sqlite';
}

const dbFile = resolveDbFile();

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('Database is not open.'));
            return;
        }
        db.run(sql, params, function onDone(error) {
            if (error) reject(error);
            else resolve({ lastID: this ? this.lastID : undefined, changes: this ? this.changes : 0 });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('Database is not open.'));
            return;
        }
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row);
        });
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('Database is not open.'));
            return;
        }
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(Array.isArray(rows) ? rows : []);
        });
    });
}

// Serializes every write. Without this two saves can interleave on the single
// connection and the second can land on a stale read.
function enqueueWrite(operation) {
    const next = writeQueue.catch(() => undefined).then(operation);
    writeQueue = next;
    pendingWrites.add(next);
    const cleanup = () => pendingWrites.delete(next);
    next.then(cleanup, cleanup);
    return next;
}

function initialize() {
    if (db) return Promise.resolve(db);

    return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(dbFile), { recursive: true });
        const handle = new sqlite3.Database(dbFile, error => {
            if (error) {
                reject(error);
                return;
            }
            // Durability and concurrency settings.
            //   journal_mode=WAL is persistent in the file header.
            //   synchronous and foreign_keys are per-connection, so they are
            //   applied on every open rather than relying on the file.
            handle.exec('PRAGMA journal_mode = WAL;', pragmaError => {
                if (pragmaError) {
                    handle.close(() => reject(pragmaError));
                    return;
                }
                handle.exec('PRAGMA synchronous = FULL;', syncError => {
                    if (syncError) {
                        handle.close(() => reject(syncError));
                        return;
                    }
                    handle.exec('PRAGMA foreign_keys = ON;', fkError => {
                        if (fkError) {
                            handle.close(() => reject(fkError));
                            return;
                        }
                        db = handle;
                        createSchema()
                            .then(() => {
                                // Confirm the durability setting really took.
                                // SQLite numbering: 0=OFF, 1=NORMAL,
                                // 2=FULL, 3=EXTRA. Anything below 2 means a
                                // power loss could lose a committed save.
                                return get('PRAGMA synchronous').then(row => {
                                    const level = row ? Number(row.synchronous) : -1;
                                    if (level < 2) {
                                        throw new Error(
                                            `Expected synchronous=FULL (2) but the connection reports ${level}. ` +
                                            'Player saves would not be crash-safe.'
                                        );
                                    }
                                });
                            })
                            .then(() => resolve(db))
                            .catch(schemaError => {
                                handle.close(() => reject(schemaError));
                            });
                    });
                });
            });
        });
    });
}

function createSchema() {
    return run(`
        CREATE TABLE IF NOT EXISTS accounts (
            account_id      TEXT PRIMARY KEY,
            username        TEXT NOT NULL UNIQUE,
            password_hash   TEXT NOT NULL,
            characters_json TEXT NOT NULL DEFAULT '[]',
            created_at      INTEGER NOT NULL
        )
    `).then(() => run(`
        CREATE TABLE IF NOT EXISTS players (
            char_name  TEXT PRIMARY KEY,
            state_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `)).then(() => run(`
        CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username)
    `));
}

// --- players -------------------------------------------------------------

function playerKey(charName) {
    if (typeof charName !== 'string' || charName.trim().length === 0) {
        throw new TypeError('Player name must be a non-empty string.');
    }
    return charName.trim().toLowerCase();
}

function assertSnapshot(playerData) {
    if (!playerData || typeof playerData !== 'object' || Array.isArray(playerData)) {
        throw new TypeError('Player data must be an object.');
    }
    // Round-trip through JSON so a value that cannot be stored (functions,
    // cycles) fails here rather than corrupting the column later.
    return JSON.parse(JSON.stringify(playerData));
}

function loadPlayer(charName) {
    let key;
    try {
        key = playerKey(charName);
    } catch (error) {
        return Promise.reject(error);
    }
    return initialize().then(() => {
        return get('SELECT state_json FROM players WHERE char_name = ?', [key]).then(row => {
            if (!row || typeof row.state_json !== 'string') return null;
            const parsed = JSON.parse(row.state_json);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            return parsed;
        });
    });
}

function savePlayer(charName, playerData) {
    // Validate inside the try so an invalid name or payload surfaces as a
    // rejected promise like every other async failure here, rather than a
    // synchronous throw that a .catch() downstream would never see.
    let key;
    let snapshot;
    try {
        key = playerKey(charName);
        snapshot = assertSnapshot(playerData);
    } catch (error) {
        return Promise.reject(error);
    }
    return enqueueWrite(() => initialize().then(() => run(
        `INSERT INTO players (char_name, state_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(char_name) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
        [key, JSON.stringify(snapshot), Date.now()]
    )));
}

function deletePlayer(charName) {
    let key;
    try {
        key = playerKey(charName);
    } catch (error) {
        return Promise.reject(error);
    }
    return enqueueWrite(() => initialize().then(() => run('DELETE FROM players WHERE char_name = ?', [key])));
}

function listPlayers() {
    return initialize().then(() => all('SELECT char_name FROM players ORDER BY char_name'))
        .then(rows => rows.map(row => row.char_name));
}

function getLeaderboard(limit = 100) {
    // char_name is selected alongside state_json because the character's name is not
    // inside state_json at all -- serializePlayer has no `name` field. Reading p.name
    // from the parsed record therefore yielded undefined for every row, and the client
    // renders this name beside the medal it awards.
    return initialize().then(() => all('SELECT char_name, state_json FROM players'))
        .then(rows => {
            const players = rows.map(row => ({
                name: row.char_name,
                record: JSON.parse(row.state_json)
            }));
            players.sort((a, b) => (b.record.level || 1) - (a.record.level || 1));
            return players.slice(0, limit).map(p => ({
                name: p.name,
                level: p.record.level || 1,
                classType: p.record.classType || 'warrior'
            }));
        });
}

// --- accounts ------------------------------------------------------------

function readCharacters(value) {
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string') : [];
    } catch (error) {
        console.error("FATAL: Corrupt characters_json encountered.", error);
        throw new Error("Corrupt characters_json: " + error.message);
    }
}

function loadAccounts() {
    return initialize().then(() => all('SELECT * FROM accounts')).then(rows => {
        const accounts = {};
        rows.forEach(row => {
            accounts[row.username] = {
                accountId: row.account_id,
                username: row.username,
                passwordHash: row.password_hash,
                characters: readCharacters(row.characters_json),
                createdAt: row.created_at
            };
        });
        return accounts;
    });
}

function getAccountById(accountId) {
    return initialize().then(() => get(
        'SELECT * FROM accounts WHERE account_id = ?',
        [accountId]
    )).then(row => {
        if (!row) return null;
        return {
            accountId: row.account_id,
            username: row.username,
            passwordHash: row.password_hash,
            characters: readCharacters(row.characters_json),
            createdAt: row.created_at
        };
    });
}

function getAccountByUsername(username) {
    return initialize().then(() => get(
        'SELECT * FROM accounts WHERE username = ?',
        [username]
    )).then(row => {
        if (!row) return null;
        return {
            accountId: row.account_id,
            username: row.username,
            passwordHash: row.password_hash,
            characters: readCharacters(row.characters_json),
            createdAt: row.created_at
        };
    });
}

function insertAccount(account) {
    return enqueueWrite(() => initialize().then(() => run(
        'INSERT INTO accounts (account_id, username, password_hash, characters_json, created_at) VALUES (?, ?, ?, ?, ?)',
        [account.accountId, account.username, account.passwordHash, JSON.stringify(account.characters || []), account.createdAt]
    )));
}

function addCharacterToAccount(accountId, characterName) {
    return enqueueWrite(() => initialize().then(() => get(
        'SELECT characters_json FROM accounts WHERE account_id = ?', [accountId]
    ).then(row => {
        if (!row) return false;
        let characters = readCharacters(row.characters_json);
        if (characters.includes(characterName)) return true;
        characters.push(characterName);
        return run(
            'UPDATE accounts SET characters_json = ? WHERE account_id = ?',
            [JSON.stringify(characters), accountId]
        ).then(() => true);
    })));
}

async function flush() {
    while (pendingWrites.size > 0) {
        await Promise.all(Array.from(pendingWrites));
    }
}

function close() {
    if (!db) return Promise.resolve();
    const handle = db;
    db = null;
    return flush().then(() => new Promise((resolve, reject) => {
        handle.close(error => (error ? reject(error) : resolve()));
    }));
}

module.exports = {
    file: dbFile,
    initialize,
    loadPlayer,
    savePlayer,
    deletePlayer,
    listPlayers,
    getLeaderboard,
    loadAccounts,
    getAccountById,
    getAccountByUsername,
    insertAccount,
    addCharacterToAccount,
    flush,
    close
};
