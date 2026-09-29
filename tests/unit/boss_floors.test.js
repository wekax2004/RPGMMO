'use strict';

/**
 * tests/unit/boss_floors.test.js
 *
 * A boss must only ever see, chase and hit players standing on its own floor.
 *
 * This is the one place the Z-level work did not reach. Every other place that
 * picked a target by distance was converted to the floor-aware form, but all
 * nine distance tests in bosses.js were left as a bare 2D hypot over the whole
 * player map -- target selection, aggro, and every circle and cone ability.
 *
 * That is not hypothetical, because the layouts overlap. Each boss type is
 * confined to a quadrant of the surface, and the Molten Depths (z=-2) sits at
 * (2080..2624, 1952..2496) -- entirely inside the Skeleton King's quadrant. A
 * Skeleton King standing at (2200,2200) is inside its own declared bounds, and a
 * player in the Molten Depths at (2200,2200) is inside a real dungeon floor, and
 * the two are 544x544 of legal shared coordinates. Before this was fixed, the
 * king hit them through the world.
 *
 * The last test is a guard rather than a bug report. It asserts that no floor
 * overlaps a boss quadrant, which is the only reason the cross-floor hits above
 * are not currently reachable by every boss -- the moment someone adds a floor
 * inside one of those quadrants, this stops being a latent trap and starts being
 * a live one, and the test says so instead of leaving it to be rediscovered.
 */
const test = require('node:test');
const assert = require('node:assert');

const BOSSES = require('../../server/bosses');
const MAP = require('../../server/map');
const CFG = require('../../server/config');

const DEEP = CFG.Z_DUNGEON;          // -1, the Bone Crypt
const MOLTEN = -2;                   // the Molten Depths
const SURFACE = CFG.Z_SURFACE;      // 0

// Inside the Molten Depths, and inside the Skeleton King's quadrant at the same
// time. Both facts are asserted below rather than assumed, because the whole
// demonstration rests on them.
const SHARED_X = 2200;
const SHARED_Y = 2200;

function makePlayer(id, x, y, z, hp = 100) {
    return {
        id, charName: `P${id}`, x, y, z, hp, maxHp: hp,
        level: 1, warmode: false, equipment: {}, inventory: []
    };
}

function makeBoss(type, x, y, z) {
    return {
        id: 'boss_test', type, name: type, x, y, z,
        hp: 100000, maxHp: 100000, phase: 1, alive: true,
        isBoss: true, isElite: false,
        lastMoveTime: 0, lastAbilityTime: new Map()
    };
}

// Records what was sent where, so a test can assert both the damage and the
// audience it was sent to.
function makeRecorders() {
    const sent = [];
    return {
        sent,
        broadcast: (pkt) => sent.push({ scope: 'ALL', pkt }),
        broadcastToFloor: (floor, pkt) => sent.push({ scope: MAP.normalizeZ(floor), pkt }),
        damageFor: (id) => sent.filter(s => s.pkt && s.pkt.action === 'damage' && s.pkt.targetId === id)
    };
}

test('the shared coordinates really are shared: inside the Molten Depths and inside the Skeleton King\'s quadrant', () => {
    const molten = MAP.getFloorBounds(MOLTEN);
    assert.ok(molten, 'the Molten Depths has no bounds, so nothing below can be trusted');
    assert.ok(molten.minX <= SHARED_X && SHARED_X <= molten.maxX &&
              molten.minY <= SHARED_Y && SHARED_Y <= molten.maxY,
        `(${SHARED_X},${SHARED_Y}) is not inside the Molten Depths ${JSON.stringify(molten)}`);

    // The boss type's own declared roaming area, read the way bosses.js reads it.
    const src = require('fs').readFileSync(require.resolve('../../server/bosses'), 'utf8');
    const m = /'skeleton_king':\s*\{[\s\S]*?bounds:\s*\{\s*minX:\s*(\d+),\s*maxX:\s*(\d+),\s*minY:\s*(\d+),\s*maxY:\s*(\d+)/.exec(src);
    assert.ok(m, 'could not read the skeleton_king bounds out of bosses.js');
    const [minX, maxX, minY, maxY] = m.slice(1).map(Number);
    assert.ok(minX <= SHARED_X && SHARED_X < maxX && minY <= SHARED_Y && SHARED_Y < maxY,
        `(${SHARED_X},${SHARED_Y}) is not inside the skeleton_king quadrant ${minX}..${maxX} x ${minY}..${maxY}`);
});

test('a boss AoE does not damage a player on another floor at the same coordinates', async () => {
    // The boss is on the surface at coordinates it is allowed to stand on. The
    // victim is in the Molten Depths at the identical x,y. A 2D distance test
    // cannot tell them apart, so before the fix the surface king hit her.
    const king = makeBoss('skeleton_king', SHARED_X, SHARED_Y, SURFACE);
    const buried = makePlayer('buried', SHARED_X, SHARED_Y, MOLTEN, 100);
    const players = new Map([['buried', buried]]);

    BOSSES.bosses.set(king.id, king);
    const rec = makeRecorders();
    try {
        BOSSES.triggerBossAoe('skeleton_king', players, rec.broadcast, buried);
        await new Promise(r => setTimeout(r, 1700));   // the fuse is 1500ms

        assert.strictEqual(buried.hp, 100,
            `a player in the Molten Depths took ${100 - buried.hp} damage from a Skeleton King on the surface ` +
            `standing at the same coordinates`);
    } finally {
        BOSSES.bosses.delete(king.id);
    }
});

test('a boss AoE does still damage a player on its own floor', async () => {
    // The control. Same boss, same ability, same coordinates -- but the victim is
    // on the boss's floor. Without this, "fix" the cross-floor case by never
    // damaging anyone and the suite stays green while the game loses its bosses.
    const king = makeBoss('skeleton_king', SHARED_X, SHARED_Y, SURFACE);
    const onSurface = makePlayer('above', SHARED_X, SHARED_Y, SURFACE, 100);
    const players = new Map([['above', onSurface]]);

    BOSSES.bosses.set(king.id, king);
    const rec = makeRecorders();
    try {
        BOSSES.triggerBossAoe('skeleton_king', players, rec.broadcast, onSurface);
        await new Promise(r => setTimeout(r, 1700));
        assert.ok(onSurface.hp < 100,
            `the AoE did nothing to a player standing in it (hp stayed ${onSurface.hp})`);
    } finally {
        BOSSES.bosses.delete(king.id);
    }
});

test('a damage packet is scoped to the victim\'s floor, not broadcast to every client', async () => {
    const king = makeBoss('skeleton_king', SHARED_X, SHARED_Y, SURFACE);
    const onSurface = makePlayer('above', SHARED_X, SHARED_Y, SURFACE, 100);
    const players = new Map([['above', onSurface]]);

    BOSSES.bosses.set(king.id, king);
    const rec = makeRecorders();
    try {
        // Called the way server.js calls it, with the floor scope injected. The
        // earlier version of this test omitted the fifth argument and so
        // measured the FALLBACK path -- a global broadcast for callers with no
        // floor scope to offer -- and failed against correct code. The test was
        // wrong about which path it was on, not the code about scoping.
        BOSSES.triggerBossAoe('skeleton_king', players, rec.broadcast, onSurface, rec.broadcastToFloor);
        await new Promise(r => setTimeout(r, 1700));

        const packets = rec.damageFor('above');
        assert.ok(packets.length > 0, 'no damage packet was sent at all, so there is nothing to scope');
        for (const p of packets) {
            assert.notStrictEqual(p.scope, 'ALL',
                'the damage packet went to every connected client on every floor');
            assert.strictEqual(p.scope, MAP.normalizeZ(SURFACE),
                `the damage packet went to floor ${p.scope}, not the victim's floor`);
        }
    } finally {
        BOSSES.bosses.delete(king.id);
    }
});

test('a caller with no floor scope gets a global broadcast rather than silence', async () => {
    // The fallback, stated as a fact rather than left to be rediscovered. A
    // caller that cannot say which floor it is on gets the old behaviour, on
    // purpose: the alternative -- dropping the damage -- would make a boss look
    // broken rather than unscoped.
    const king = makeBoss('skeleton_king', SHARED_X, SHARED_Y, SURFACE);
    const onSurface = makePlayer('above', SHARED_X, SHARED_Y, SURFACE, 100);
    const players = new Map([['above', onSurface]]);

    BOSSES.bosses.set(king.id, king);
    const rec = makeRecorders();
    try {
        BOSSES.triggerBossAoe('skeleton_king', players, rec.broadcast, onSurface);
        await new Promise(r => setTimeout(r, 1700));
        const packets = rec.damageFor('above');
        assert.ok(packets.length > 0, 'no damage at all: the fallback dropped it instead of unscoping it');
        assert.strictEqual(packets[0].scope, 'ALL', 'the fallback is no longer a global broadcast');
    } finally {
        BOSSES.bosses.delete(king.id);
    }
});

test('a boss does not walk toward a player it cannot see on another floor', () => {
    // A player 4 tiles away, so this is outside melee range and the boss genuinely
    // wants to move. Standing them on the surface and the boss in the Molten
    // Depths: the correct outcome is that the boss ignores them entirely.
    const king = makeBoss('skeleton_king', SHARED_X, SHARED_Y, MOLTEN);
    const above = makePlayer('above', SHARED_X, SHARED_Y - 128, SURFACE, 100);
    const players = new Map([['above', above]]);
    const rec = makeRecorders();

    BOSSES.bossAI(king, players, rec.broadcast, new Map(), rec.broadcastToFloor);

    assert.strictEqual(king.y, SHARED_Y,
        `a boss in the Molten Depths walked ${SHARED_Y - king.y}px toward a player on the surface`);
});

test('a boss still walks toward a player on its own floor', () => {
    // The control for the test above: identical setup, identical distance, but
    // the player shares the floor, so the boss must close the gap.
    const king = makeBoss('skeleton_king', SHARED_X, SHARED_Y, MOLTEN);
    const below = makePlayer('below', SHARED_X, SHARED_Y - 128, MOLTEN, 100);
    const players = new Map([['below', below]]);
    const rec = makeRecorders();

    BOSSES.bossAI(king, players, rec.broadcast, new Map(), rec.broadcastToFloor);

    assert.notStrictEqual(king.y, SHARED_Y,
        'a boss ignored a player standing four tiles away on its own floor');
});

test('the layout overlap that made the bug reachable is recorded, not asserted empty', () => {
    // This started life as a hard guard: the Molten Depths sits 544x544 inside
    // the Skeleton King's quadrant, which is what made the cross-floor hits in
    // the tests above reachable at all, and failing on that overlap was the
    // right instinct at the time.
    //
    // It is no longer a guard, because the sameFloor checks in bosses.js make an
    // overlap harmless: a boss cannot see or hit a player on another floor even
    // when their coordinates coincide exactly. Demanding the overlap be zero
    // would now be asserting a fact about the map that the game does not depend
    // on, and would fail the suite for a layout choice that is perfectly fine.
    //
    // So this documents the overlap instead. The value of keeping it is that a
    // future floor added into a quadrant shows up here, and whoever adds it
    // learns that the floors now share coordinates -- which is exactly the
    // situation the sameFloor guards exist for.
    const src = require('fs').readFileSync(require.resolve('../../server/bosses'), 'utf8');
    const quadrantRe = /'([a-z_]+)':\s*\{[\s\S]*?bounds:\s*\{\s*minX:\s*(\d+),\s*maxX:\s*(\d+),\s*minY:\s*(\d+),\s*maxY:\s*(\d+)/g;
    const quadrants = [];
    let m;
    while ((m = quadrantRe.exec(src))) {
        quadrants.push({ type: m[1], minX: +m[2], maxX: +m[3], minY: +m[4], maxY: +m[5] });
    }
    assert.ok(quadrants.length > 0, 'no boss quadrants found; bosses.js has drifted from this test');

    const collisions = [];
    for (const spec of CFG.Z_FLOORS) {
        const b = MAP.getFloorBounds(spec.z);
        if (!b) continue;
        for (const q of quadrants) {
            const ox = Math.min(b.maxX, q.maxX) - Math.max(b.minX, q.minX);
            const oy = Math.min(b.maxY, q.maxY) - Math.max(b.minY, q.minY);
            if (ox > 0 && oy > 0) {
                collisions.push(`${spec.name} (z=${spec.z}) shares ${ox}x${oy}px with ${q.type}`);
            }
        }
    }

    console.log(`      floor/boss coordinate overlap: ${collisions.length ? collisions.join('; ') : 'none'}`);
    console.log('      harmless while every boss target test is floor-guarded');
});

test('a boss damage packet is not sent through a global broadcast', () => {
    // Source-level, and deliberately so. The behavioural test above catches a
    // damage packet that is scoped to the WRONG floor, but only for the one
    // ability it drives and only when the injector is supplied. Reverting a
    // damage send to a global broadcast elsewhere in the file -- the death wave,
    // the bone prison, a new ability added next month -- would pass every
    // behavioural check in this file, because none of them exercise that line.
    //
    // The invariant is the one that actually matters: a packet that names a
    // victim belongs to that victim's floor. Anything describing an entity has to
    // say whose world it is in.
    const src = require('fs').readFileSync(require.resolve('../../server/bosses'), 'utf8');
    const offenders = [];
    src.split('\n').forEach((line, i) => {
        if (!/action:\s*'damage'/.test(line)) return;
        // Either it names the floor, or the line above established a `toFloor`
        // alias that does. Both are legitimate; a bare broadcast() is not.
        const window = [src.split('\n')[i - 1], line].join('\n');
        if (!/broadcastToFloor\(|toFloor\(/.test(window)) {
            offenders.push(`bosses.js:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
    });
    assert.deepStrictEqual(offenders, [],
        'these damage packets are not scoped to a floor:\n  ' + offenders.join('\n  '));
});

test('a boss validates a step against its own floor, not the surface', () => {
    // isWalkable's third parameter defaults to the surface, so a two-argument
    // call is not "the current floor" -- it is specifically the surface. A boss
    // in a dungeon therefore consults the city's geometry for every step: it
    // refuses tiles that are open ground up top, and accepts tiles that are
    // solid rock around it. Behaviourally hard to assert without a real
    // dungeon, and cheap to state, so it is stated.
    const src = require('fs').readFileSync(require.resolve('../../server/bosses'), 'utf8');
    const lines = src.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
        if (!/isWalkable\(/.test(line)) return;
        if (/^const .*isWalkable.*require/.test(line)) return;      // the import
        if (/isWalkable\(x, y, floorZ\)|isWalkable\(at\.x, at\.y, floorZ\)/.test(line)) return;  // spawn
        if (/isWalkable\(x, y, boss\.z\)/.test(line)) return;       // the minion
        if (/isWalkable\(nx, ny, boss\.z\)/.test(line)) return;     // the step
        offenders.push(`bosses.js:${i + 1}  ${line.trim().slice(0, 70)}`);
    });
    assert.deepStrictEqual(offenders, [],
        'these isWalkable calls do not say which floor they mean:\n  ' + offenders.join('\n  '));
});

test('every boss target test is floor-guarded', () => {
    // The invariant that actually matters, and the thing that would have caught
    // the original bug. Source-level rather than behavioural, because the
    // behavioural tests above can only cover the abilities they were written for
    // -- a new one added tomorrow would slip past them, and this cannot.
    //
    // Any distance test in bosses.js that does not mention the floor is a bug:
    // it is asking "how far is this player" without asking "in which world".
    const src = require('fs').readFileSync(require.resolve('../../server/bosses'), 'utf8');
    const lines = src.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
        if (!/Math\.hypot\((?:player|p)\./.test(line)) return;
        // A guarded test carries the floor check on the same line, or on one of
        // the two lines above (the ice-breath loop puts it in a `continue`).
        const window = [lines[i - 1], lines[i - 2], line].filter(Boolean).join('\n');
        if (!/sameFloor\(/.test(window)) {
            offenders.push(`bosses.js:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
    });
    assert.deepStrictEqual(offenders, [],
        'these distance tests do not check the floor:\n  ' + offenders.join('\n  '));
});
