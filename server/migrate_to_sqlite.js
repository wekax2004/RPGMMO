'use strict';

/**
 * One-off migration from the flat JSON stores to SQLite.
 *
 *   node migrate_to_sqlite.js
 *
 * Reads server/data/accounts.json and server/data/players.json, writes them
 * into the accounts and players tables, then renames the originals to .migrated
 * so nothing is destroyed. Safe to run twice: already-migrated rows are
 * skipped unless --force is passed.
 *
 * The originals are only renamed after every row is committed, so an
 * interrupted run leaves the JSON in place and the migration re-runnable.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const DB = require('./database');

const dataDir = path.join(__dirname, 'data');
const accountsFile = path.join(dataDir, 'accounts.json');
const playersFile = path.join(dataDir, 'players.json');
const force = process.argv.includes('--force');

function readJsonIfPresent(file) {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Unexpected shape in ${file}`);
    }
    return parsed;
}

async function alreadyPresent() {
    const existing = await DB.listPlayers();
    return existing.length;
}

async function main() {
    console.log(`[migrate] target database: ${DB.file}`);
    await DB.initialize();

    const accounts = readJsonIfPresent(accountsFile) || {};
    const players = readJsonIfPresent(playersFile) || {};

    const playerNames = Object.keys(players);
    const usernames = Object.keys(accounts);

    if (playerNames.length === 0 && usernames.length === 0) {
        console.log('[migrate] Nothing to migrate.');
        return;
    }

    const existingCount = await alreadyPresent();
    if (existingCount > 0 && !force) {
        console.log(`[migrate] ${existingCount} player row(s) already in the database.`);
        console.log('[migrate] Re-run with --force to overwrite them from JSON.');
        return;
    }

    let accountsMigrated = 0;
    for (const username of usernames) {
        const account = accounts[username];
        if (!account || typeof account !== 'object') continue;
        if (!account.accountId || typeof account.passwordHash !== 'string') {
            console.warn(`[migrate] skipping malformed account '${username}'`);
            continue;
        }
        try {
            await DB.insertAccount({
                accountId: account.accountId,
                username,
                passwordHash: account.passwordHash,
                characters: Array.isArray(account.characters) ? account.characters : [],
                createdAt: Number.isSafeInteger(account.createdAt) ? account.createdAt : Date.now()
            });
            accountsMigrated++;
        } catch (error) {
            if (String(error.message).includes('UNIQUE')) {
                console.warn(`[migrate] account '${username}' already exists, skipping`);
            } else {
                throw error;
            }
        }
    }

    let playersMigrated = 0;
    for (const charName of playerNames) {
        const state = players[charName];
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
            console.warn(`[migrate] skipping malformed player '${charName}'`);
            continue;
        }
        await DB.savePlayer(charName, state);
        playersMigrated++;
    }

    await DB.flush();
    await DB.close();

    // Only now retire the JSON sources.
    for (const file of [accountsFile, playersFile]) {
        if (fs.existsSync(file)) {
            const target = `${file}.migrated`;
            await fsp.rename(file, target);
            console.log(`[migrate] renamed ${path.basename(file)} -> ${path.basename(target)}`);
        }
    }

    console.log(`[migrate] done. ${accountsMigrated} account(s), ${playersMigrated} player(s).`);
}

main().catch(error => {
    console.error('[migrate] FAILED:', error.message);
    process.exitCode = 1;
});
