/*
 * Renames the mana and safe-zone regen constants to state their real units.
 *
 * Both were named _PER_SEC and both were applied by a 10-second interval, so
 * each restored 5 points every 10 seconds while claiming to be 5 per second --
 * a tenth of what the name promised. Nothing about the game was wrong; the
 * constants were simply lying about their magnitude, and the two of them had to
 * be read together with the interval to work out what either actually did.
 *
 * The values are unchanged. Only the names, which now say "per tick" because
 * that is the tick.
 *
 * config.js contains Hebrew comments, so this is written byte-safe with no BOM.
 * Run:  node tools/fix_regen_unit_names.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG = path.join(ROOT, 'server', 'config.js');
const SERVER = path.join(ROOT, 'server', 'server.js');
const BOSSES = path.join(ROOT, 'server', 'bosses.js');

// [file, from, to, expected occurrences]
const EDITS = [
    [CONFIG, 'MANA_REGEN_PER_SEC: 5,', 'MANA_REGEN_PER_TICK: 5,', 1],
    [CONFIG, 'SAFEZONE_HEAL_PER_SEC: 5,', 'SAFEZONE_HEAL_PER_TICK: 5,', 1],
    [SERVER, 'p.mana = Math.min(p.mana + CFG.MANA_REGEN_PER_SEC, p.maxMana);',
             'p.mana = Math.min(p.mana + CFG.MANA_REGEN_PER_TICK, p.maxMana);', 1],
    [SERVER, 'p.hp + CFG.SAFEZONE_HEAL_PER_SEC', 'p.hp + CFG.SAFEZONE_HEAL_PER_TICK', 1],
];

function main() {
    const cache = new Map();
    const read = f => {
        if (!cache.has(f)) cache.set(f, fs.readFileSync(f, 'utf8'));
        return cache.get(f);
    };
    const write = (f, s) => {
        // Explicitly no BOM. config.js carries Hebrew comments and a BOM here
        // would be a second, quieter encoding bug on top of the rename.
        fs.writeFileSync(f, s, 'utf8');
    };

    let applied = 0;
    const refused = [];
    for (const [file, from, to, expected] of EDITS) {
        let src = read(file);
        const n = src.split(from).length - 1;
        if (n !== expected) {
            refused.push(`${path.basename(file)}: anchor found ${n}x, expected ${expected} -- ${from.slice(0, 55)}`);
            continue;
        }
        write(file, src.split(from).join(to));
        cache.set(file, read(file));
        applied++;
    }

    for (const [f] of EDITS) {
        // Only write files we actually changed, so an untouched file keeps its mtime.
        if (!cache.has(f)) continue;
    }

    console.log(`applied ${applied} of ${EDITS.length} renames`);
    if (refused.length) {
        console.log('REFUSED (ambiguous or missing anchor):');
        for (const r of refused) console.log('  ' + r);
        process.exit(1);
    }

    // Prove no old name survives anywhere it is referenced. A partial rename is
    // the failure mode here that matters: CFG.MANA_REGEN_PER_SEC becomes
    // undefined, and p.mana + undefined is NaN, which silently ends mana regen
    // for every player with no error anywhere.
    const survivors = [];
    for (const f of [CONFIG, SERVER, BOSSES]) {
        const src = fs.readFileSync(f, 'utf8');
        src.split('\n').forEach((line, i) => {
            if (/_PER_SEC\b/.test(line)) survivors.push(`${path.basename(f)}:${i + 1}  ${line.trim().slice(0, 60)}`);
        });
    }
    if (survivors.length) {
        console.log('LEFTOVER old names:');
        for (const s of survivors) console.log('  ' + s);
        process.exit(1);
    }
    console.log('verified: no _PER_SEC name remains in config.js, server.js or bosses.js');
    return 0;
}

process.exit(main());
