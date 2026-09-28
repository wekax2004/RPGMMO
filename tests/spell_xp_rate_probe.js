/*
 * Measures the magic-XP-per-second obtainable by spamming cast_spell with no
 * enemy in range. Guards a real balance hole: castSpell has no cooldown, and
 * trainSpell fires on a successful cast regardless of whether a spell hit
 * anything, so a player can farm magic XP standing still in the safe zone.
 */
const path = require('path');
const os = require('os');
const ServerController = require('./lib/server_controller');

const PORT = 8153;
const DB_FILE = path.join(os.tmpdir(), `tibia-spellspam-${process.pid}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('\n=== cast_spell XP-rate measurement (no enemies, no movement) ===\n');
    const server = new ServerController({
        port: PORT, dbFile: DB_FILE, env: { TIBIA_DB_DRIVER: 'sqlite' }
    });
    await server.start();

    const WS = require('ws');
    const ws = new WS(`ws://127.0.0.1:${PORT}`);
    let magic = 0, loggedIn = false, loggedOff = false;
    ws.on('message', raw => {
        let p; try { p = JSON.parse(raw.toString()); } catch { return; }
        if (p.action === 'your_id') { loggedIn = true; loggedOff = false; }
        if (p.action === 'skill_update' && p.skill && p.skill.skill === 'magic') magic = p.skill.xp;
    });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    ws.send(JSON.stringify({ action: 'login', name: 'SpamMage', class: 'mage', warmode: false }));
    for (let i = 0; i < 40 && !loggedIn; i++) await sleep(100);
    console.log(`  logged in: ${loggedIn}`);
    await sleep(800);

    // Confirm nothing is in range to attack.
    const startMagic = magic;
    const WINDOW_MS = 20000;
    const started = Date.now();
    let casts = 0;
    while (Date.now() - started < WINDOW_MS) {
        ws.send(JSON.stringify({ action: 'cast_spell' }));
        casts++;
        await sleep(25);      // ~40 casts/sec attempted
    }
    await sleep(600);

    const gained = magic - startMagic;
    const seconds = (Date.now() - started) / 1000;
    console.log(`  window            : ${seconds.toFixed(1)}s`);
    console.log(`  cast attempts     : ${casts} (~${(casts / seconds).toFixed(0)}/sec)`);
    console.log(`  magic XP gained   : ${gained}`);
    console.log(`  magic XP rate     : ${(gained / seconds).toFixed(2)}/sec`);
    const idleOk = gained === 0;
    console.log(`  ${idleOk ? 'PASS' : 'FAIL'}  casting with no enemy grants no magic XP`);

    // ---------- the positive case: a spell that HITS must still train ----------
    // Asserting only "no XP when idle" would also pass if the award had been
    // removed entirely, so the other direction must be checked too.
    console.log('\n  --- control: does a spell that connects still train magic? ---');
    const mobs = new Map();
    ws.on('message', raw => {
        try {
            const p = JSON.parse(raw.toString());
            if (p.action === 'mob_update' && typeof p.x === 'number' && p.alive !== false) mobs.set(p.id, p);
        } catch { /* ignore */ }
    });
    // The 20s spam above drained the caster, and a cast is refused with OOM
    // before it reaches the spell logic. Mana regen is only applied once per
    // 10s tick, so waiting would take minutes; grant it instead. Then spawn the
    // mob, because mobs wander and would drift out of the 100px Frost Nova
    // radius by the time the cast lands.
    console.log('  (granting mana, then spawning a mob at the caster)');
    ws.send(JSON.stringify({ action: 'test_grant_mana', amount: 200 }));
    await new Promise(r => setTimeout(r, 700));
    ws.send(JSON.stringify({ action: 'test_spawn_mob', type: 'spider' }));
    await new Promise(r => setTimeout(r, 900));
    const target = [...mobs.values()].pop();
    if (!target) {
        console.log('  FAIL  no mob was spawned, cannot verify the positive case');
    } else {
        const before = magic;
        // Frost Nova (spellIndex 2) is unconditional and centred on the caster,
        // so it does not depend on the target assignment sticking.
        for (let i = 0; i < 2; i++) {
            ws.send(JSON.stringify({ action: 'cast_spell', spellIndex: 2 }));
            await new Promise(r => setTimeout(r, 4200));
        }
        await new Promise(r => setTimeout(r, 800));
        const earned = magic - before;
        const hitOk = earned > 0;
        console.log(`  ${hitOk ? 'PASS' : 'FAIL'}  a spell that hits a mob still grants magic XP -- gained ${earned}`);
        if (!idleOk || !hitOk) process.exitCode = 1;
    }

    ws.close();
    await server.stop(true);
    for (const s of ['', '-wal', '-shm', '-journal']) {
        require('fs').rmSync(DB_FILE.replace(/\.json$/, '.sqlite') + s, { force: true });
        require('fs').rmSync(DB_FILE + s, { force: true });
    }
}
main().catch(e => { console.error(e); process.exit(1); });
