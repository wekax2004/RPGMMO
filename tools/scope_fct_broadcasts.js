'use strict';
/**
 * Rewrites positional `fct` (floating combat text) broadcasts to be
 * floor-scoped.
 *
 * Every `fct` packet carries a world coordinate, so a global broadcast puts
 * text from one floor on another floor's screen, at coordinates that mean
 * nothing there: a surface player watches "+30 XP" float over a dungeon
 * corpse, and a player gathering in a cave drops loot text onto the surface.
 *
 * The entity is read off the x expression, so a site that references something
 * unrecognised is reported rather than guessed. Run with --apply to write.
 *
 * Run:  node tools/scope_fct_broadcasts.js [--apply]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['server/server.js', 'server/combat.js'];
const APPLY = process.argv.includes('--apply');

// Entities whose .z is the floor the text belongs to.
const ENTITIES = [
    'p', 'player', 'target', 'mob', 'm', 'boss', 'caster', 'closest', 'seller', 'b', 'a', 'other'
];

// `broadcast({ action: 'fct', x: <entity>.<expr>, ... })` -- the entity name is
// the first identifier of the x expression, and the rest of the expression is
// preserved verbatim so `m.x+16` and `player.x + 16` both survive intact.
const CALL = /broadcast\(\{\s*action:\s*'fct',\s*x:\s*([A-Za-z_$][\w$]*)\.([^,]+),/g;

let totalRewritten = 0;
let unresolved = 0;

for (const rel of FILES) {
    const full = path.join(ROOT, rel);
    let src = fs.readFileSync(full, 'utf8');
    const rewritten = src.replace(CALL, (match, base, rest) => {
        if (!ENTITIES.includes(base)) {
            unresolved++;
            console.log(`  UNRESOLVED ${rel}: ${match.slice(0, 90)}`);
            return match;
        }
        totalRewritten++;
        return `broadcastToFloor(${base}.z, { action: 'fct', x: ${base}.${rest},`;
    });

    if (APPLY && rewritten !== src) {
        fs.writeFileSync(full, rewritten, 'utf8');
        console.log(`  wrote ${rel}`);
    } else if (rewritten !== src) {
        console.log(`  would rewrite ${rel}`);
    }
}

console.log(`\n  rewritable sites : ${totalRewritten}`);
console.log(`  unresolved        : ${unresolved}`);
if (unresolved > 0) {
    console.log('  Unresolved sites are NOT guessed. Handle them by hand.');
}
if (!APPLY && totalRewritten > 0) console.log('  dry run -- pass --apply to write');
