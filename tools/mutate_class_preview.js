/*
 * Re-injects defects in the class-select sprite preview, and confirms
 * tests/browser/test_class_preview.js fails for each.
 *
 * Run:  node tools/mutate_class_preview.js --port=8143
 *
 * Started from a real failure: the previews rendered as four blank canvases and
 * every source-level check was green. A plausible drawImage call is not evidence
 * that anything was drawn, which is why this feature needed a browser test at all
 * and why the mutations below target the things that made it silently empty.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENGINE = 'client/js/engine.js';

const portArg = process.argv.indexOf('--port');
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 8143;

const MUTATIONS = [
    {
        // Found by running the harness: the canvases are looked up through a
        // variable, not by the literal expression this first anchored on.
        name: 'the preview canvas lookup is broken',
        file: ENGINE,
        from: "const c = document.getElementById('preview-' + cls);",
        to: "const c = document.getElementById('preview-nonexistent-' + cls);"
    },
    {
        name: 'the preview loop never runs at all',
        file: ENGINE,
        from: 'const drawPreviews = () => {',
        to: 'const drawPreviews = () => { return 0;'
    },
    {
        name: 'the poll gives up after a single attempt, as the old fixed delay did',
        file: ENGINE,
        from: 'if (pending === 0 || previewAttempts > 100) {',
        to: 'if (pending === 0 || previewAttempts > 1) {'
    },
    {
        name: 'the sprite is drawn one pixel off the canvas, so it reads as blank',
        file: ENGINE,
        from: 'ctx.drawImage(img, dx, dy, w, h);',
        to: 'ctx.drawImage(img, 9999, 9999, w, h);'
    },
    {
        name: 'all four classes draw the same sprite',
        file: ENGINE,
        from: 'const img = window.getSprite(cls);',
        to: 'const img = window.getSprite("warrior");'
    },
    {
        name: 'the sprite is stretched to fill instead of fitted',
        // Kept only because it is now checked for validity rather than assumed to
        // be a behaviour change. On a square source drawn to a square canvas the
        // fitted call reduces to drawImage(img, 0, 0, 32, 32), which is exactly
        // what this mutation produces, so it is a no-op. It is recorded here as a
        // deliberate no-op mutation: the harness counts it, and it must be reported
        // as survived, because a mutation that changes nothing SHOULD pass. If this
        // ever needs to become a real mutation, the source has to be non-square
        // first.
        expectNoop: true,
        file: ENGINE,
        from: 'ctx.drawImage(img, dx, dy, w, h);',
        to: 'ctx.drawImage(img, 0, 0, c.width, c.height);'
    },
    {
        name: 'the death modal is never shown on hp 0',
        file: ENGINE,
        from: 'if (dm) dm.style.display = "block";',
        to: 'if (dm) dm.style.display = "none";'
    },
    {
        name: 'the death modal is never cleared on respawn',
        file: ENGINE,
        from: 'dm.style.display = "none";\n                        document.getElementById("overlay").style.display = "none";',
        to: '/* not cleared */'
    },
    {
        name: 'the death branch fires on any hp change, not only a death',
        file: ENGINE,
        from: 'if (data.hp <= 0 && (!lastKnownHp || lastKnownHp > 0)) {',
        to: 'if (data.hp !== lastKnownHp) {'
    }
];

function runProbe() {
    try {
        const out = execFileSync(process.execPath,
            [path.join(ROOT, 'tests', 'e2e_runner.js'),
             '--suite=browser', '--test=class_preview', `--port=${PORT}`],
            { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: (e.stdout || '') + (e.stderr || '') };
    }
}

function failedChecks(out) {
    return [...out.matchAll(/✗\s{2,}(.+)/g)].map(m => m[1].trim());
}

const originals = new Map();
for (const m of MUTATIONS) {
    const abs = path.join(ROOT, m.file);
    if (!originals.has(abs)) originals.set(abs, fs.readFileSync(abs, 'utf8'));
}

console.log(`=== class preview mutation testing (port ${PORT}) ===\n`);
const base = runProbe();
if (!base.ok) {
    console.log('  baseline probe FAILS; fix that before mutating.');
    console.log(failedChecks(base.out).map(l => '    ' + l).join('\n'));
    process.exit(1);
}
console.log('  baseline: probe passes (previews are painted, death screen works)');

let survived = 0;
try {
    for (const m of MUTATIONS) {
        const abs = path.join(ROOT, m.file);
        const src = originals.get(abs);
        if (!src.includes(m.from)) {
            console.log(`  SKIP      ${m.name}`);
            console.log('            anchor not found -- engine.js drifted, update this harness\n');
            survived++;
            continue;
        }
        fs.writeFileSync(abs, src.replace(m.from, m.to), 'utf8');
        const result = runProbe();
        fs.writeFileSync(abs, src, 'utf8');

        if (m.expectNoop) {
            // A mutation that changes nothing must survive. Reporting it as caught
            // would mean the probe is failing for a reason unrelated to the change,
            // which is worse than useless.
            console.log(`${result.ok ? 'NO-OP   ' : 'UNEXPECTED'}  ${m.name}`);
            if (result.ok) {
                console.log('            probe passed, as it must: the mutation is a no-op\n');
            } else {
                console.log('            probe FAILED on a no-op mutation -- investigate\n');
                survived++;
            }
            continue;
        }

        if (result.ok) {
            survived++;
            console.log(`  SURVIVED  ${m.name}`);
            console.log('            the probe passed with the feature broken\n');
        } else {
            const failed = failedChecks(result.out);
            console.log(`  CAUGHT    ${m.name}`);
            console.log(`            ${failed.length ? failed.join('; ').slice(0, 62) : 'probe errored'}`);
        }
    }
} finally {
    for (const [abs, src] of originals) fs.writeFileSync(abs, src, 'utf8');
}

console.log(`\n  ${MUTATIONS.length - survived} caught, ${survived} survived`);
if (survived) {
    console.log('\n  A surviving mutation means the preview can be empty and the suite still says so.');
    process.exitCode = 1;
} else {
    console.log('  Every mutation was caught.');
}