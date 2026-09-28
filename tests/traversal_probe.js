/*
 * Probes the static file handler for path traversal. The guard in
 * serveClientFile looks correct on paper; this confirms it against encoded
 * and malformed paths that a source read would not catch.
 */
const path = require('path');
const os = require('os');
const http = require('http');
const ServerController = require('./lib/server_controller');

const PORT = 8154;
const DB_FILE = path.join(os.tmpdir(), `tibia-traversal-${process.pid}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sends a raw path with no client-side normalization, so the server sees
// exactly what an attacker would put on the wire.
function rawGet(rawPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, method: 'GET', path: rawPath,
            headers: { Host: '127.0.0.1' }
        }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

const PROBES = [
    ['/js/engine.js',                      'legit css/js route'],
    ['/js/../../server/database.js',        'plain traversal'],
    ['/js/%2e%2e%2f%2e%2e%2fserver/database.js', 'encoded traversal'],
    ['/js/..%2f..%2fserver/database.js',    'mixed traversal'],
    ['/js/....//....//server/database.js',  'double-dot bypass'],
    ['/assets/../../server/auth.js',        'traversal via assets'],
    ['/assets/%2e%2e/%2e%2e/server/auth.js', 'encoded via assets'],
    ['/js/..%5c..%5cserver/database.js',    'backslash traversal'],
    ['/assets/%',                           'malformed percent (the old 500)'],
    ['/js/%zz',                             'invalid hex escape'],
    ['/../package.json',                    'traversal to package.json'],
    ['/assets/..%2f..%2f..%2fpackage.json', 'encoded traversal to root'],
    ['/js/../../../../../../Windows/win.ini', 'traversal out of the drive'],
];

// If any of these leak, it is a real disclosure bug.
const LEAKS = ['"require(', 'CREATE TABLE', 'scrypt', 'passwordHash', 'TIBIA_', '[extensions]', 'Mozilla'];

async function main() {
    console.log('\n=== static handler path-traversal probe ===\n');
    const server = new ServerController({
        port: PORT, dbFile: DB_FILE, env: { TIBIA_DB_DRIVER: 'sqlite' }
    });
    await server.start();

    let leaks = 0;
    for (const [rawPath, label] of PROBES) {
        let r;
        try {
            r = await rawGet(rawPath);
        } catch (e) {
            console.log(`  ERR   ${rawPath.padEnd(48)} ${e.message}`);
            continue;
        }
        const found = LEAKS.filter(s => r.body.includes(s));
        const bad = found.length > 0;
        if (bad) leaks++;
        const verdict = bad ? 'LEAK!!' : r.status === 200 ? '200 ok' : `${r.status}`;
        console.log(`  ${verdict.padEnd(8)} ${rawPath.padEnd(48)} ${label}${bad ? `  -> ${found.join(',')}` : ''}`);
    }

    // The server must still be alive after all that.
    let alive = false;
    try {
        const r = await rawGet('/js/engine.js');
        alive = r.status === 200;
    } catch { /* ignore */ }
    console.log(`\n  server still serving after all probes: ${alive ? 'YES' : 'NO -- it died'}`);
    console.log(`  leaks detected: ${leaks === 0 ? 'NONE' : leaks}`);

    await server.stop(true);
    for (const s of ['', '-wal', '-shm', '-journal']) {
        require('fs').rmSync(DB_FILE.replace(/\.json$/, '.sqlite') + s, { force: true });
        require('fs').rmSync(DB_FILE + s, { force: true });
    }
    process.exit(leaks === 0 && alive ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
