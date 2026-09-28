/*
 * Measures whether a graceful shutdown folds the write-ahead log back into the
 * main database file.
 *
 * DB.flush() only waits for queued writes; it does not checkpoint. Without a
 * close(), the WAL is left on disk and grows to whatever the busiest moment
 * needed. This checks the fix actually moves the bytes.
 *
 * Run:  node tests/wal_checkpoint_probe.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const ServerController = require('./lib/server_controller');

const PORT = 8185;
const BASE = path.join(os.tmpdir(), `tibia-wal-${process.pid}.json`);
const SQLITE = BASE.replace(/\.json$/, '.sqlite');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(label, condition, detail) {
    const ok = !!condition;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? ` -- ${detail}` : ''}`);
    return ok;
}

const sizeOf = suffix => {
    try { return fs.statSync(SQLITE + suffix).size; } catch { return 0; }
};
const report = label => {
    const db = sizeOf('');
    const wal = sizeOf('-wal');
    console.log(`    ${label}: db=${db} wal=${wal}`);
    return { db, wal };
};

// Drives N logins so the server actually writes player rows.
async function driveLogins(count) {
    const WS = require('ws');
    let remaining = count;
    await new Promise((resolve) => {
        const one = (i) => {
            if (remaining-- <= 0) return resolve();
            const ws = new WS(`ws://127.0.0.1:${PORT}`);
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                try { ws.close(); } catch { /* ignore */ }
                setTimeout(() => one(i + 1), 120);
            };
            ws.on('open', () => ws.send(JSON.stringify({ action: 'login', name: `Wal${i}`, class: 'warrior' })));
            ws.on('message', raw => {
                try {
                    const p = JSON.parse(raw.toString());
                    // Wait for the first status push, which happens after the
                    // character has been loaded and queued for saving.
                    if (p.action === 'status' || p.action === 'quest_journal') setTimeout(finish, 250);
                } catch { /* ignore */ }
            });
            ws.on('error', finish);
            setTimeout(finish, 4000);
        };
        one(0);
    });
}

async function main() {
    console.log('\n=== WAL checkpoint on graceful shutdown ===\n');
    let server = new ServerController({ port: PORT, dbFile: BASE, env: { TIBIA_DB_DRIVER: 'sqlite' } });
    try {
        await server.start();
        await driveLogins(8);
        await sleep(1200);

        const during = report('while running');
        check('the WAL grew above the main file during play', during.wal > during.db,
            `wal=${during.wal} vs db=${during.db}`);

        // ServerController.stop() sends the graceful SHUTDOWN message and lets
        // the process run its shutdown path.
        await server.stop();
        await sleep(1200);

        const after = report('after graceful shutdown');
        console.log('');

        check('a graceful shutdown closes the database', after.wal === 0 || after.wal < during.wal,
            `wal went ${during.wal} -> ${after.wal}`);
        check('the WAL no longer dwarfs the database',
            after.wal <= Math.max(after.db, 4096),
            `wal=${after.wal}, db=${after.db}`);
        if (after.wal > 0) {
            console.log('    (a non-zero WAL is fine if SQLite truncated it below the db size;');
            console.log('     the failure mode is a WAL that keeps growing)');
        }
        console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===\n`);
    } finally {
        try { await server.stop(true); } catch { /* ignore */ }
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            fs.rmSync(SQLITE + suffix, { force: true });
            fs.rmSync(BASE + suffix, { force: true });
        }
    }
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error('\nprobe crashed:', err); process.exit(1); });
