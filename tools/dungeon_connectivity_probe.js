'use strict';
/**
 * Can a randomly placed pillar make the dungeon's exit unreachable?
 *
 * This is the soft-lock question. The player descends on a one-way ladder; if a
 * pillar generation ever walls the stairs off from the arrival point, they are
 * stuck below with no way back up and no admin to fix it. Nothing about the
 * feature is correct if that can happen even occasionally.
 *
 * Run:  node tools/dungeon_connectivity_probe.js
 */
const CFG = require('../server/config');

const W = CFG.DUNGEON_TILES_W;
const H = CFG.DUNGEON_TILES_H;
const PILLARS = CFG.DUNGEON_PILLARS;
const TRIALS = 5000;

const ENTRANCE = { tx: 1, ty: 1 };
const EXIT = { tx: Math.floor(W / 2), ty: Math.floor(H / 2) };

// Exactly the generator in server/map.js, in tile space. A pillar is kept only
// if the exit is still reachable -- the same rule the real generator applies.
function generate() {
    const solid = new Set();
    for (let tx = 0; tx < W; tx++) {
        for (let ty = 0; ty < H; ty++) {
            if (tx === 0 || ty === 0 || tx === W - 1 || ty === H - 1) solid.add(`${tx},${ty}`);
        }
    }
    const reserved = new Set([`${ENTRANCE.tx},${ENTRANCE.ty}`, `${EXIT.tx},${EXIT.ty}`]);
    for (let i = 0; i < PILLARS; i++) {
        const tx = 2 + Math.floor(Math.random() * Math.max(1, W - 4));
        const ty = 2 + Math.floor(Math.random() * Math.max(1, H - 4));
        const key = `${tx},${ty}`;
        if (solid.has(key) || reserved.has(key)) continue;
        solid.add(key);
        if (!reachable({ solid })) solid.delete(key);
    }
    return solid;
}

function reachable(floor) {
    const solid = floor.solid;
    const seen = new Set([`${ENTRANCE.tx},${ENTRANCE.ty}`]);
    const queue = [[ENTRANCE.tx, ENTRANCE.ty]];
    while (queue.length) {
        const [x, y] = queue.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const key = `${nx},${ny}`;
            if (solid.has(key) || seen.has(key)) continue;
            seen.add(key);
            queue.push([nx, ny]);
        }
    }
    return seen.has(`${EXIT.tx},${EXIT.ty}`);
}

let sealed = 0;
let example = null;
let pillarsPlaced = 0;
for (let t = 0; t < TRIALS; t++) {
    const solid = generate();
    pillarsPlaced += solid.size - (2 * W + 2 * H - 4);
    if (!reachable({ solid })) {
        sealed++;
        if (!example) example = [...solid].sort().join(' ');
    }
}

const pct = (sealed / TRIALS * 100).toFixed(2);
console.log(`  cave            : ${W}x${H} tiles, ${PILLARS} pillars requested`);
console.log(`  trials          : ${TRIALS} random generations`);
console.log(`  entrance        : (${ENTRANCE.tx},${ENTRANCE.ty})`);
console.log(`  exit            : (${EXIT.tx},${EXIT.ty})`);
console.log(`  pillars kept    : ${(pillarsPlaced / TRIALS).toFixed(2)} on average (of ${PILLARS} requested)`);
console.log(`  sealed dungeons : ${sealed} (${pct}%)`);
if (example) console.log(`  a sealed layout : ${example}`);
if (sealed === 0) {
    console.log('\n  the exit is reachable in every generation -- no soft-lock.');
} else {
    console.log(`\n  *** ${pct}% of dungeons are a soft-lock: the player descends and can never climb out.`);
}
process.exitCode = sealed === 0 ? 0 : 1;
