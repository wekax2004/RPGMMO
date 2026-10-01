/*
 * Re-injects the keybinding bugs this suite exists to catch, one at a time, and
 * confirms the suite goes red for each. A green test proves nothing until the
 * assertions have been shown to fail against the code they describe.
 *
 * Run:  node tools/mutate_keybindings.js
 * Exits non-zero if any mutation survives.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Relative to ROOT, so the loop below can join them. An absolute path here
// produced C:\...\tibia_mmo\C:\...\tibia_mmo\client\js\engine.js and every
// mutation silently became a no-op once the baseline map was filled.
const ENGINE = 'client/js/engine.js';
const HTML = 'client/test_client.html';
const TEST = 'tests/unit/keybindings.test.js';

// [name, file, from, to]
const MUTATIONS = [
    {
        name: 'the original defect: key "1" bound twice, the second unreachable',
        file: ENGINE,
        from: '            if (e.key === "Tab") {',
        to: '            if (e.key === "1") castPurify();\n' +
            '            if (e.key === "2") castSkill();\n' +
            '            if (e.key === "Tab") {'
    },
    {
        name: 'the proposed "fix": the spellIndex bindings removed',
        file: ENGINE,
        from: '            if (e.key === "1") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 1 })); return; }\n' +
              '            if (e.key === "2") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 2 })); return; }',
        to: '            if (e.key === "1") { castPurify(); return; }\n' +
            '            if (e.key === "2") { castSkill(); return; }'
    },
    {
        name: 'the proposed "fix", taken literally: the epic binding removed too',
        file: ENGINE,
        from: '            if (e.key === "r" || e.key === "R") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 3 })); return; }\n',
        to: ''
    },
    {
        name: 'the spell keys stop carrying a spellIndex',
        file: ENGINE,
        from: 'if (e.key === "1") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 1 })); return; }',
        to: 'if (e.key === "1") { socket.send(JSON.stringify({ action: "cast_spell" })); return; }'
    },
    {
        name: 'Purify loses its own binding and is click-only again',
        file: ENGINE,
        from: '            if (e.key === "p" || e.key === "P") { castPurify(); return; }\n',
        to: ''
    },
    {
        name: 'the HUD claims a key the handler does not test',
        file: HTML,
        from: "Purify (Press 'P') - 20 MP",
        to: "Purify (Press 'J') - 20 MP"
    },
    {
        name: 'the help bar drops the epic binding',
        file: HTML,
        from: " | Epic: 'R'",
        to: ''
    },
    {
        name: 'the healer divergence is no longer documented on the button',
        file: HTML,
        from: 'A healer instead casts Flash Heal on a target.',
        to: 'It does something special.'
    },
    {
        name: 'the world-map M binding reappears alongside the audio one (shadowed)',
        file: ENGINE,
        from: '            if (e.key === "Tab") {',
        to: '            if (e.key === "m" || e.key === "M") toggleAudio();\n' +
            '            if (e.key === "Tab") {'
    },
    {
        name: 'the audio tooltip claims M again, which opens the map',
        file: HTML,
        from: 'onclick="toggleAudio()" title="Toggle sound"',
        to: 'onclick="toggleAudio()" title="Toggle sound (M)"'
    },
    {
        name: 'the help bar drops the map binding',
        file: HTML,
        from: " | Map: 'M'",
        to: ''
    },
    {
        name: 'the world-map key moves to an undocumented double-quoted key',
        file: ENGINE,
        from: "if (e.key.toLowerCase() === 'm') {",
        to: 'if (e.key.toLowerCase() === "j") {'
    }
];

/*
 * Deliberately NOT mutated, and why:
 *
 *   if (e.key.toLowerCase().charAt(0) === 'm')
 *
 * A binding written in a shape this checker does not recognise is invisible to
 * it, by construction -- a regex reading source text cannot in general tell what
 * a JavaScript expression computes. That is a real limit of the check, not a gap
 * that can be closed by trying harder, and pretending otherwise would be worse
 * than stating it. The two spellings that actually occur in this handler are
 * both handled and both are mutated above.
 */

function runSuite() {
    try {
        const out = execFileSync(process.execPath, ['--test', TEST], {
            cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
        });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

function firstFailure(out) {
    const m = out.match(/✖ ([^\n]+)/);
    return m ? m[1].trim().slice(0, 74) : '(no failure line found)';
}

const originals = new Map();
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs, 'utf8'));
}

console.log('=== keybinding mutation testing ===\n');
const base = runSuite();
console.log(`  baseline: ${base.ok ? 'passes' : 'ALREADY FAILING'}`);
if (!base.ok) {
    console.log('    ' + firstFailure(base.out));
    console.log('\n  ABORT: the suite is not green before mutating, so nothing below means anything.');
    process.exit(1);
}

let survived = 0;
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    const src = originals.get(abs);
    if (!src.includes(m.from)) {
        console.log(`  SKIP    ${m.name}`);
        console.log('          anchor not found -- the source drifted, update this harness\n');
        survived++;
        continue;
    }
    fs.writeFileSync(abs, src.replace(m.from, m.to), 'utf8');
    const result = runSuite();
    fs.writeFileSync(abs, src, 'utf8');   // restore immediately

    if (result.ok) {
        survived++;
        console.log(`  SURVIVED  ${m.name}`);
        console.log('            the suite passed against broken code\n');
    } else {
        console.log(`  CAUGHT    ${m.name}`);
        console.log(`            ${firstFailure(result.out)}\n`);
    }
}

console.log(`  ${MUTATIONS.length - survived} caught, ${survived} survived`);
if (survived) {
    console.log('\n  A surviving mutation means an assertion is decorative.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation was caught.');
}