// Tests for the SQLite persistence layer. Each file uses its own database so
// the suite stays isolated and can run in parallel.
process.env.TIBIA_DB_DRIVER = 'sqlite';
process.env.TIBIA_DB_FILE = require('path').join(
    require('os').tmpdir(),
    `tibia_db_test_${process.pid}.json`
);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const DB = require('../../server/database');

test.after(async () => {
    await DB.close();
    // Remove the database and its WAL/SHM siblings.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        fs.rmSync(DB.file + suffix, { force: true });
    }
});

test('the database file is created on initialize', async () => {
    await DB.initialize();
    assert.ok(fs.existsSync(DB.file), 'database file should exist after initialize');
});

test('a .json TIBIA_DB_FILE is mapped to a .sqlite path', () => {
    // Guards the compatibility shim: the harness passes players.json.
    assert.match(DB.file, /\.sqlite$/);
    assert.doesNotMatch(DB.file, /\.json$/);
});

test('savePlayer then loadPlayer round-trips the state', async () => {
    const state = { level: 7, gold: 1234, inventory: ['Sword', 'Potion'], quests: { active: {}, completed: ['q1'] } };
    await DB.savePlayer('RoundTrip', state);
    const loaded = await DB.loadPlayer('RoundTrip');
    assert.deepStrictEqual(loaded, state);
});

test('player names are stored case-insensitively', async () => {
    await DB.savePlayer('MixedCase', { level: 1 });
    const lower = await DB.loadPlayer('mixedcase');
    const upper = await DB.loadPlayer('MIXEDCASE');
    assert.ok(lower, 'lowercase lookup should find the row');
    assert.deepStrictEqual(lower, upper, 'both lookups should return the same row');
});

test('saving the same character twice overwrites rather than duplicating', async () => {
    await DB.savePlayer('Twice', { level: 1, gold: 10 });
    await DB.savePlayer('Twice', { level: 2, gold: 99 });
    const loaded = await DB.loadPlayer('Twice');
    assert.strictEqual(loaded.level, 2);
    assert.strictEqual(loaded.gold, 99);
    const names = await DB.listPlayers();
    assert.strictEqual(names.filter(n => n === 'twice').length, 1, 'exactly one row');
});

test('loading an unknown character returns null, not undefined', async () => {
    const result = await DB.loadPlayer('NeverSaved');
    assert.strictEqual(result, null);
});

test('concurrent saves for different characters all land', async () => {
    // The regression this replaces: the old file store rewrote the whole JSON
    // per save, so parallel writes could erase each other.
    await Promise.all([
        DB.savePlayer('ParA', { level: 1, marker: 'a' }),
        DB.savePlayer('ParB', { level: 2, marker: 'b' }),
        DB.savePlayer('ParC', { level: 3, marker: 'c' }),
        DB.savePlayer('ParD', { level: 4, marker: 'd' })
    ]);
    await DB.flush();
    const a = await DB.loadPlayer('ParA');
    const b = await DB.loadPlayer('ParB');
    const c = await DB.loadPlayer('ParC');
    const d = await DB.loadPlayer('ParD');
    assert.deepStrictEqual([a.marker, b.marker, c.marker, d.marker], ['a', 'b', 'c', 'd']);
});

test('serial writes to one character keep the last value', async () => {
    for (let i = 1; i <= 20; i++) {
        await DB.savePlayer('Churn', { level: i });
    }
    await DB.flush();
    const loaded = await DB.loadPlayer('Churn');
    assert.strictEqual(loaded.level, 20, 'final write wins');
});

test('the caller\'s object is not mutated or aliased by the store', async () => {
    const original = { level: 1, inventory: ['Potion'] };
    await DB.savePlayer('Snapshot', original);
    // Mutating after the save must not change what was written.
    original.level = 999;
    original.inventory.push('Ghost');
    const loaded = await DB.loadPlayer('Snapshot');
    assert.strictEqual(loaded.level, 1, 'stored value is a snapshot, not a reference');
    assert.deepStrictEqual(loaded.inventory, ['Potion']);
});

test('non-object player data is rejected before it reaches the database', async () => {
    for (const bad of [null, undefined, 'a string', 42, ['array']]) {
        // savePlayer validates the name first, so give every case a valid one.
        await assert.rejects(() => DB.savePlayer('InvalidData', bad), TypeError);
    }
});

test('an empty or non-string player name is rejected', async () => {
    for (const bad of ['', '   ', null, undefined, 42, {}]) {
        await assert.rejects(() => DB.savePlayer(bad, { level: 1 }), TypeError);
        await assert.rejects(() => DB.loadPlayer(bad), TypeError);
    }
});

test('deletePlayer removes the row and is idempotent', async () => {
    await DB.savePlayer('Temp', { level: 1 });
    await DB.deletePlayer('Temp');
    assert.strictEqual(await DB.loadPlayer('Temp'), null);
    await DB.deletePlayer('Temp');
    assert.strictEqual(await DB.loadPlayer('Temp'), null);
});

test('accounts round-trip through the accounts table', async () => {
    await DB.insertAccount({
        accountId: 'acct_test_1',
        username: 'testuser',
        passwordHash: 'scrypt$16384$8$1$aa$bb',
        characters: ['hero', 'alt'],
        createdAt: 1700000000000
    });
    const accounts = await DB.loadAccounts();
    assert.ok(accounts['testuser'], 'account should be present');
    assert.strictEqual(accounts['testuser'].accountId, 'acct_test_1');
    assert.strictEqual(accounts['testuser'].passwordHash, 'scrypt$16384$8$1$aa$bb');
    assert.deepStrictEqual(accounts['testuser'].characters, ['hero', 'alt']);
    assert.strictEqual(accounts['testuser'].createdAt, 1700000000000);
});

test('a duplicate username is rejected by the UNIQUE constraint', async () => {
    await DB.insertAccount({
        accountId: 'acct_dup_1', username: 'dupuser', passwordHash: 'h1', characters: [], createdAt: 1
    });
    await assert.rejects(
        () => DB.insertAccount({
            accountId: 'acct_dup_2', username: 'dupuser', passwordHash: 'h2', characters: [], createdAt: 2
        }),
        /UNIQUE/
    );
});

test('getAccountByUsername returns null for an unknown user', async () => {
    assert.strictEqual(await DB.getAccountByUsername('ghost_user_xyz'), null);
});

test('updateCharacters persists the new list', async () => {
    await DB.insertAccount({
        accountId: 'acct_upd', username: 'upduser', passwordHash: 'h', characters: ['one'], createdAt: 1
    });
    await DB.updateCharacters('acct_upd', ['one', 'two']);
    const account = await DB.getAccountByUsername('upduser');
    assert.deepStrictEqual(account.characters, ['one', 'two']);
});

test('a malformed characters_json column degrades to an empty list', async () => {
    await DB.insertAccount({
        accountId: 'acct_bad', username: 'badjson', passwordHash: 'h', characters: ['x'], createdAt: 1
    });
    // Corrupt the column directly, the way a bad migration or a hand edit
    // would. The reader must not throw on it. sqlite3 lives in server/node_modules,
    // so resolve it from there rather than the repo root.
    const sqlite3 = require(require('path').join(__dirname, '..', '..', 'server', 'node_modules', 'sqlite3'));
    await new Promise((resolve, reject) => {
        const raw = new sqlite3.Database(DB.file, error => {
            if (error) return reject(error);
            raw.run(
                "UPDATE accounts SET characters_json = '{not json' WHERE username = ?",
                ['badjson'],
                runError => {
                    raw.close(() => (runError ? reject(runError) : resolve()));
                }
            );
        });
    });

    const account = await DB.getAccountByUsername('badjson');
    assert.ok(account, 'account should still be readable');
    assert.deepStrictEqual(account.characters, [], 'bad JSON becomes an empty list');
});

test('flush waits for writes queued before it was called', async () => {
    const writes = [
        DB.savePlayer('FlushA', { level: 1 }),
        DB.savePlayer('FlushB', { level: 2 }),
        DB.savePlayer('FlushC', { level: 3 })
    ];
    await DB.flush();
    await Promise.all(writes);
    assert.ok(await DB.loadPlayer('FlushA'));
    assert.ok(await DB.loadPlayer('FlushB'));
    assert.ok(await DB.loadPlayer('FlushC'));
});
