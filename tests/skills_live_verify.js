/*
 * Live end-to-end verification of the Skills system.
 *
 * The unit tests only prove the pure XP math. This boots a real server, logs
 * a real character in over a WebSocket, and checks that:
 *   1. the login packet carries a skill panel (4 skills, level 1)
 *   2. a melee hit on a mob grants sword xp
 *   3. casting a spell grants magic xp
 *   4. gathering ore grants mining xp
 *   5. the awarded levels survive a real SQLite round trip
 *
 * Run:  node tests/skills_live_verify.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const ServerController = require('./lib/server_controller');

const PORT = 8151;
const DB_FILE = path.join(os.tmpdir(), `tibia-skills-live-${process.pid}.json`);
const WS_URL = `ws://127.0.0.1:${PORT}`;

let failures = 0;
function check(label, condition, detail) {
    const ok = !!condition;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
    return ok;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Minimal raw client: records every packet so we can assert on them.
function connect() {
    const WS = require('ws');
    return new Promise((resolve, reject) => {
        const ws = new WS(WS_URL);
        const state = {
            ws,
            packets: [],
            skills: new Map(),   // id -> latest skill descriptor
            panelSeen: false,
            mobs: new Map(),
            nodes: new Map(),
            player: { x: 320, y: 320 },
            on: {}
        };
        state.on.packet = () => {};
        ws.on('open', () => resolve(state));
        ws.on('error', reject);
        ws.on('message', raw => {
            let packet;
            try { packet = JSON.parse(raw.toString()); } catch { return; }
            state.packets.push(packet);
            if (packet.action === 'skill_update') {
                if (Array.isArray(packet.skills)) {
                    state.panelSeen = true;
                    packet.skills.forEach(s => state.skills.set(s.skill, s));
                } else if (packet.skill) {
                    state.skills.set(packet.skill.skill, packet.skill);
                }
            }
            if (packet.action === 'mob_update') {
                // Flat shape: { action, id, type, name, x, y, hp, ... }
                if (typeof packet.x === 'number') state.mobs.set(packet.id, packet);
            }
            if (packet.action === 'node_sync') state.nodes.set(packet.id, packet);
            if (packet.action === 'your_id') state.id = packet.id;
            if (packet.action === 'player_update' && packet.id === state.id) {
                state.player.x = packet.x;
                state.player.y = packet.y;
            }
            if (packet.action === 'force_position') {
                state.player.x = packet.x;
                state.player.y = packet.y;
            }
            // Authoritative position, from our own players_sync entry. The two
            // handlers above fire on login, traversal, death and stun -- not
            // during ordinary walking -- so state.player froze wherever the
            // character last was placed and the walk to a gathering node used to
            // give up partway. players_sync arrives every ~200ms and includes
            // the receiving player, so it is the dependable read.
            if (packet.action === 'players_sync') {
                for (const e of packet.players || []) {
                    if (e.id === state.id) {
                        state.player.x = e.x;
                        state.player.y = e.y;
                    }
                }
            }
            state.on.packet(packet);
        });
    });
}

function xpOf(state, skill) {
    const s = state.skills.get(skill);
    return s ? s.xp : undefined;
}
function levelOf(state, skill) {
    const s = state.skills.get(skill);
    return s ? s.level : undefined;
}

// Walks toward (tx,ty) one TILE_SIZE step at a time, obeying the server's
// rules: a step must be exactly TILE_SIZE on one axis and 0 on the other, and
// must not repeat faster than the move cooldown. Sidesteps when blocked.
const TILE = 32;
const STEP_DELAY = 330; // move cooldown at level 1 is ~297ms; stay above it

async function walkTo(state, tx, ty, stopDist) {
    const stop = stopDist === undefined ? 0 : stopDist;
    const budget = Date.now() + 120000;
    let stuck = 0;

    while (Date.now() < budget) {
        const dx = tx - state.player.x;
        const dy = ty - state.player.y;
        if (Math.abs(dx) + Math.abs(dy) <= stop) return true;

        const primaryX = Math.abs(dx) >= Math.abs(dy);
        const candidates = primaryX
            ? [[TILE * Math.sign(dx), 0], [0, TILE * Math.sign(dy)]]
            : [[0, TILE * Math.sign(dy)], [TILE * Math.sign(dx), 0]];
        if (stuck >= 3) {
            const perp = TILE * (Math.random() < 0.5 ? 1 : -1);
            candidates.push(primaryX ? [0, perp] : [perp, 0]);
        }

        const before = `${state.player.x},${state.player.y}`;
        let advanced = false;
        for (const [sx, sy] of candidates) {
            if (sx === 0 && sy === 0) continue;
            state.ws.send(JSON.stringify({
                action: 'move', x: state.player.x + sx, y: state.player.y + sy
            }));
            await sleep(STEP_DELAY);
            if (`${state.player.x},${state.player.y}` !== before) { advanced = true; break; }
        }
        stuck = advanced ? 0 : stuck + 1;
        if (stuck > 12) return false;   // boxed in by obstacles
    }
    return false;
}

// Picks the node_sync entry nearest to the player that trains a skill.
function nearestTrainingNode(state, name) {
    const from = { x: state.player.x, y: state.player.y };
    const d = n => Math.abs(n.x - from.x) + Math.abs(n.y - from.y);
    return [...state.nodes.values()]
        .filter(n => n.name === name && n.active !== false)
        .sort((a, b) => d(a) - d(b))[0];
}

// Mobs wander, so re-derive the nearest one each time from the latest sync.
function nearestMob(state) {
    const from = { x: state.player.x, y: state.player.y };
    const d = m => Math.abs(m.x - from.x) + Math.abs(m.y - from.y);
    return [...state.mobs.values()]
        .filter(m => m.alive !== false && typeof m.x === 'number')
        .sort((a, b) => d(a) - d(b))[0];
}

// Logs in and resolves once the server confirms with your_id, retrying on
// failure. A blind sleep is racy: the very first connection can land while
// the server is still finishing startup, and the server holds a 5s login
// reservation while a login is in flight.
async function login(state, name, classType, warmode) {
    for (let attempt = 0; attempt < 6; attempt++) {
        let settled = false;
        let error = null;
        const onPacket = packet => {
            if (packet.action === 'your_id') { state.id = packet.id; settled = true; }
            if (packet.action === 'login_error' || packet.action === 'auth_error') {
                error = packet.message;
                settled = true;
            }
        };
        state.on.packet = onPacket;
        state.ws.send(JSON.stringify({ action: 'login', name, class: classType, warmode }));
        for (let waited = 0; waited < 2500 && !settled; waited += 50) await sleep(50);
        state.on.packet = () => {};
        if (state.id) return true;
        console.log(`  (login attempt ${attempt + 1} for ${name} failed${error ? `: ${error}` : ' (no your_id)'}; retrying)`);
        await sleep(400);
    }
    return false;
}

async function main() {
    console.log('\n=== SKILLS: live end-to-end verification ===\n');
    console.log(`  server port : ${PORT}`);
    console.log(`  db file     : ${DB_FILE}\n`);

    const server = new ServerController({
        port: PORT,
        dbFile: DB_FILE,
        // ServerController defaults to the legacy JSON driver; force SQLite so
        // this actually exercises the persistence layer we care about.
        env: { TIBIA_DB_DRIVER: 'sqlite' }
    });
    await server.start();

        // NOTE: gathering nodes are randomly placed per process, so we must NOT
    // read positions from a locally-required quests.js -- that would be a
    // different layout from the server's. The node_sync packets the server
    // sends on login are the only authoritative source.

    let mageState = null;
    let warriorState = null;

    try {
        // ---------- 1. login panel ----------
        console.log('[1] login delivers a full skill panel');
        warriorState = await connect();
        const warriorIn = await login(warriorState, 'SkillWarrior', 'warrior', true);
        check('warrior logged in', warriorIn);
        await sleep(600);

        check('client received a skill panel on login', warriorState.panelSeen);
        check('panel contains all four skills', ['mining', 'woodcutting', 'sword', 'magic']
            .every(s => warriorState.skills.has(s)),
            `got [${[...warriorState.skills.keys()].join(', ')}]`);
        check('every skill starts at level 1',
            ['mining', 'woodcutting', 'sword', 'magic'].every(s => levelOf(warriorState, s) === 1));
        check('every skill reports a next-level target',
            [...warriorState.skills.values()].every(s => s.xpForNext > 0));

        // ---------- 2. melee grants sword xp ----------
        console.log('\n[2] a melee hit on a mob grants sword xp');
        // Normal mob spawning is randomised across a 3200x3200 map, so
        // chasing one on foot is not reliable. TEST_MODE's test_spawn_mob
        // places one deterministically next to the player.
        const beforeSword = xpOf(warriorState, 'sword') ?? 0;
        warriorState.ws.send(JSON.stringify({ action: 'test_spawn_mob', type: 'spider' }));
        await sleep(900);
        const target = nearestMob(warriorState);
        check('a mob was available to attack', !!target);
        console.log(`  target: ${target ? `${target.name} @ ${target.x},${target.y}` : 'n/a'}  (player at ${warriorState.player.x},${warriorState.player.y})`);
        if (target) {
            let adjacent = false;
            for (let attempt = 0; attempt < 10; attempt++) {
                const mob = nearestMob(warriorState);
                if (!mob) break;
                const gap = Math.abs(mob.x - warriorState.player.x) + Math.abs(mob.y - warriorState.player.y);
                if (gap <= 1) {
                    adjacent = true;
                    warriorState.ws.send(JSON.stringify({ action: 'attack', target_id: mob.id }));
                    await sleep(500);
                } else {
                    const before = `${warriorState.player.x},${warriorState.player.y}`;
                    const mx = Math.abs(mob.x - warriorState.player.x) >= Math.abs(mob.y - warriorState.player.y);
                    warriorState.ws.send(JSON.stringify({
                        action: 'move',
                        x: warriorState.player.x + (mx ? TILE * Math.sign(mob.x - warriorState.player.x) : 0),
                        y: warriorState.player.y + (mx ? 0 : TILE * Math.sign(mob.y - warriorState.player.y))
                    }));
                    await sleep(STEP_DELAY);
                    if (`${warriorState.player.x},${warriorState.player.y}` === before) {
                        const perp = TILE * (Math.random() < 0.5 ? 1 : -1);
                        warriorState.ws.send(JSON.stringify({
                            action: 'move', x: warriorState.player.x + (mx ? 0 : perp), y: warriorState.player.y + (mx ? perp : 0)
                        }));
                        await sleep(STEP_DELAY);
                    }
                }
                if ((xpOf(warriorState, 'sword') ?? 0) > beforeSword) break;
            }
            check('reached melee range of a mob', adjacent, `player at ${warriorState.player.x},${warriorState.player.y}`);
            const afterSword = xpOf(warriorState, 'sword') ?? 0;
            check('sword xp increased after attacking', afterSword > beforeSword,
                `${beforeSword} -> ${afterSword}`);
            check('the increase is a real award, not a reset',
                afterSword >= beforeSword, `sword xp = ${afterSword}`);
            check('other skills were untouched by melee',
                (xpOf(warriorState, 'magic') ?? 0) === 0 && (xpOf(warriorState, 'mining') ?? 0) === 0);
        }

        // ---------- 3. casting grants magic xp ----------
        console.log('\n[3] casting a spell grants magic xp');
        mageState = await connect();
        const mageIn = await login(mageState, 'SkillMage', 'mage', true);
        check('mage logged in', mageIn);
        await sleep(600);
        check('mage login also delivers a skill panel', mageState.panelSeen);
        const beforeMagic = xpOf(mageState, 'magic') ?? 0;
        for (let i = 0; i < 3; i++) {
            mageState.ws.send(JSON.stringify({ action: 'cast_spell' }));
            await sleep(200);
        }
        await sleep(600);
        const afterMagic = xpOf(mageState, 'magic') ?? 0;
        check('magic xp increased after casting', afterMagic > beforeMagic,
            `${beforeMagic} -> ${afterMagic}`);

        // ---------- 4. gathering ore grants mining xp ----------
        console.log('\n[4] gathering ore grants mining xp');
        const gatherer = await connect();
        const minerIn = await login(gatherer, 'SkillMiner', 'warrior', false);
        check('gatherer logged in', minerIn);
        await sleep(600);
        const beforeMining = xpOf(gatherer, 'mining') ?? 0;
        const beforeWood = xpOf(gatherer, 'woodcutting') ?? 0;
        // Positions must come from the server's own node_sync packets: nodes
        // are randomly placed per process, so a locally-required quests.js
        // would describe a different world.
        const ore = nearestTrainingNode(gatherer, 'Iron Ore');
        check('the server synced an Iron Ore node to the client', !!ore);
        console.log(`  target: ${ore ? `${ore.name} @ ${ore.x},${ore.y}` : 'n/a'}  (player at ${gatherer.player.x},${gatherer.player.y})`);
        if (ore) {
            const reached = await walkTo(gatherer, ore.x, ore.y, 0);
            check('walked onto the ore node', reached, `at ${gatherer.player.x},${gatherer.player.y} want ${ore.x},${ore.y}`);
            await sleep(700);
            const afterMining = xpOf(gatherer, 'mining') ?? 0;
            const gotNode = gatherer.packets.some(p => p.action === 'node_remove');
            const inv = (gatherer.packets.filter(p => p.action === 'status').pop() || {}).inventory;
            check('the node was actually gathered', gotNode);
            check('the ore landed in the inventory', Array.isArray(inv) && inv.includes('Iron Ore'),
                `inventory = ${JSON.stringify(inv)}`);
            check('mining xp increased from gathering ore', afterMining > beforeMining,
                `${beforeMining} -> ${afterMining}`);
            // The walk to the ore may cross other nodes, so assert the
            // correspondence rather than assuming a clean path: woodcutting
            // must have gained XP if and only if Wood was actually gathered.
            const gotWood = Array.isArray(inv) && inv.includes('Wood');
            const afterWood = xpOf(gatherer, 'woodcutting') ?? 0;
            check('woodcutting tracks whether Wood was gathered', gotWood === (afterWood > beforeWood),
                `Wood gathered=${gotWood}, woodcutting ${beforeWood} -> ${afterWood}`);

            // ---------- 6. crafting expansion ----------
            console.log('\n[5] high-tier crafting works through the real workbench');
            const crafter = await connect();
            const crafterIn = await login(crafter, 'SkillCrafter', 'warrior', false);
            check('crafter logged in', crafterIn);
            await sleep(600);

            // Walk to the workbench; the server rejects crafting from afar.
            const WORKBENCH = { x: 352, y: 448 };   // CRAFTING.WORKBENCH
            const atBench = await walkTo(crafter, WORKBENCH.x, WORKBENCH.y, 0);
            check('walked onto the workbench', atBench, `at ${crafter.player.x},${crafter.player.y}`);

            // The new recipes must be offered to the client.
            crafter.ws.send(JSON.stringify({ action: 'open_crafting' }));
            await sleep(700);
            const craftOpen = crafter.packets.filter(p => p.action === 'crafting_open').pop();
            const offered = craftOpen ? craftOpen.recipes.map(r => r.id) : [];
            for (const id of ['craft_spider_silk_robes', 'craft_frost_blade', 'craft_dragon_scale_armor', 'craft_venom_fang_sabre']) {
                check(`the server offers ${id}`, offered.includes(id));
            }

            // Level up so the high-tier level gates are satisfied.
            for (let i = 0; i < 40; i++) {
                crafter.ws.send(JSON.stringify({ action: 'test_grant_xp', amount: 100000 }));
                await sleep(60);
            }
            await sleep(800);
            const levelNow = (crafter.packets.filter(p => p.action === 'status').pop() || {}).level;
            check('reached a high enough level to craft the top tier', levelNow >= 20, `level ${levelNow}`);

            // Stock the boss materials and prerequisite knowledge.
            // Stock exactly what the three recipes consume:
            //   frost_blade ......... Frost Shard 4, Iron Ore 6
            //   dragon_scale_armor .. Dragon Scale 6, Leather 4, Iron Ore 4
            //   spider_silk_robes ... Spider Silk 8, Leather 3
            // so Iron Ore must cover both the blade and the armour (10).
            const stock = [];
            const add = (item, n) => { for (let i = 0; i < n; i++) stock.push(item); };
            add('Spider Silk', 8);
            add('Leather', 8);
            add('Iron Ore', 12);
            add('Frost Shard', 4);
            add('Dragon Scale', 6);
            for (const item of stock) {
                crafter.ws.send(JSON.stringify({ action: 'test_grant_item', item }));
                await sleep(20);
            }
            await sleep(900);
            const stockedInv = (crafter.packets.filter(p => p.action === 'status').pop() || {}).inventory || [];
            check('the boss materials were granted', stockedInv.includes('Dragon Scale') && stockedInv.includes('Frost Shard'),
                `dragon scales=${stockedInv.filter(i => i === 'Dragon Scale').length}, frost shards=${stockedInv.filter(i => i === 'Frost Shard').length}`);

            // Craft the two-step Dragon Scale Armor chain for real.
            crafter.ws.send(JSON.stringify({ action: 'craft_item', recipe_id: 'craft_frost_blade' }));
            await sleep(600);
            let invNow = (crafter.packets.filter(p => p.action === 'status').pop() || {}).inventory || [];
            check('crafted a Frost Blade through the workbench', invNow.includes('Frost Blade'),
                `inventory has Frost Blade: ${invNow.includes('Frost Blade')}`);

            crafter.ws.send(JSON.stringify({ action: 'craft_item', recipe_id: 'craft_dragon_scale_armor' }));
            await sleep(600);
            invNow = (crafter.packets.filter(p => p.action === 'status').pop() || {}).inventory || [];
            check('crafted Dragon Scale Armor through the workbench', invNow.includes('Dragon Scale Armor'),
                `inventory has Dragon Scale Armor: ${invNow.includes('Dragon Scale Armor')}`);

            // The materials must actually have been consumed.
            const scalesLeft = invNow.filter(i => i === 'Dragon Scale').length;
            check('the Dragon Scales were consumed by the craft', scalesLeft === 0,
                `dragon scales left = ${scalesLeft}`);

            // Silk was stocked to exactly the recipe's requirement, so this
            // craft is designed to succeed. The property that matters is that
            // the inputs are gone and the product is present -- a craft that
            // half-succeeded would leave both.
            crafter.ws.send(JSON.stringify({ action: 'craft_item', recipe_id: 'craft_spider_silk_robes' }));
            await sleep(600);
            const afterRefuse = (crafter.packets.filter(p => p.action === 'status').pop() || {}).inventory || [];
            check('Spider Silk Robes crafted and its Silk consumed',
                afterRefuse.includes('Spider Silk Robes') && !afterRefuse.includes('Spider Silk'),
                `robes=${afterRefuse.includes('Spider Silk Robes')}, silk left=${afterRefuse.filter(i => i === 'Spider Silk').length}`);

            crafter.ws.close();
            await sleep(400);

            // ---------- 5. persistence ----------
            console.log('\n[6] skills survive a real SQLite round trip');
            const levelBefore = levelOf(gatherer, 'mining');
            const xpBefore = xpOf(gatherer, 'mining');
            // Disconnect so the server flushes the player row to SQLite.
            gatherer.ws.close();
            await sleep(1200);
            await server.stop();
            await sleep(600);

            const saved = await readSavedPlayer('SkillMiner');
            check('the player row was written to SQLite', !!saved);
            if (saved) {
                check('skills are present in the persisted row', !!saved.skills,
                    `skills = ${JSON.stringify(saved.skills)}`);
                check('all four skills persisted',
                    ['mining', 'woodcutting', 'sword', 'magic'].every(s => saved.skills && saved.skills[s]));
                check('mining level round-tripped',
                    saved.skills && saved.skills.mining.level === levelBefore,
                    `expected ${levelBefore}, got ${saved.skills && saved.skills.mining.level}`);
                check('mining xp round-tripped',
                    saved.skills && saved.skills.mining.xp === xpBefore,
                    `expected ${xpBefore}, got ${saved.skills && saved.skills.mining.xp}`);
                check('the rest of the player state still round-trips',
                    saved.level !== undefined && Array.isArray(saved.inventory));
            }
        }
    } finally {
        for (const s of [warriorState, mageState]) {
            try { if (s && s.ws.readyState === 1) s.ws.close(); } catch { /* ignore */ }
        }
        try { await server.stop(true); } catch { /* ignore */ }
        for (const suffix of ['', '-wal', '-shm', '-journal']) {
            fs.rmSync(DB_FILE.replace(/\.json$/, '.sqlite') + suffix, { force: true });
            fs.rmSync(DB_FILE + suffix, { force: true });
        }
    }

    console.log(`\n=== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===\n`);
    process.exit(failures === 0 ? 0 : 1);
}

// Reads the raw state_json blob straight out of SQLite, bypassing the server.
function readSavedPlayer(charName) {
    return new Promise((resolve, reject) => {
        const sqlite3 = require(path.join(__dirname, '..', 'server', 'node_modules', 'sqlite3'));
        const file = DB_FILE.replace(/\.json$/, '.sqlite');
        const raw = new sqlite3.Database(file, err => {
            if (err) return reject(err);
            raw.get('SELECT state_json FROM players WHERE LOWER(char_name) = LOWER(?)', [charName], (err2, row) => {
                raw.close(() => {
                    if (err2) return reject(err2);
                    if (!row) return resolve(null);
                    try { resolve(JSON.parse(row.state_json)); } catch (e) { reject(e); }
                });
            });
        });
    });
}

main().catch(err => {
    console.error('\nverification crashed:', err);
    process.exit(1);
});
