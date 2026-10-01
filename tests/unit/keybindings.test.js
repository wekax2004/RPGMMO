/*
 * tests/unit/keybindings.test.js
 *
 * The keyboard cannot have two meanings at once, and a label cannot advertise a
 * key the handler does not listen for.
 *
 * This file exists because it happened. The client bound "1" and "2" twice: once
 * as cast_spell with a spellIndex, returning early, and once further down as
 * castPurify()/castSkill(). The second pair was unreachable, which is invisible
 * from the outside -- pressing 1 cast the class's primary spell, and the button
 * beside it said "Purify (Press '1')". Nothing errored. The HUD was simply
 * lying, and it took reading the handler to find out.
 *
 * The obvious fix -- delete the first binding because the later one "matches the
 * HUD" -- would have removed the epic spell, which had no other binding and no
 * button, and made the class primary spell unreachable from the keyboard. So the
 * bindings here are pinned by assertion rather than by convention: the next
 * duplicate keybind fails this file instead of quietly shadowing one of two
 * handlers.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'client', 'js', 'engine.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'client', 'test_client.html'), 'utf8');

// The keydown handler, from its declaration to the end of the file. Taking the
// whole tail is deliberate: the handler is the last thing in the file, and a
// binding added after it would not be seen if this stopped at a fixed line.
const handlerStart = ENGINE.indexOf('document.addEventListener("keydown"');
assert.ok(handlerStart > 0, 'could not find the keydown handler in engine.js');
const HANDLER = ENGINE.slice(handlerStart);

// Every key the handler tests for, with the line it is on so a failure names a
// location rather than just a key.
/*
 * Standalone key bindings: an `if` whose condition is nothing but a test of
 * e.key, possibly an `||` chain for a letter that has a shifted form.
 *
 * Deliberately narrow. Two things in this handler look like duplicate bindings
 * and are not:
 *
 *   if (e.key === "r" || e.key === "R")   one binding written for both cases
 *   if (e.key === "Enter" && chat...)      guarded by a second condition
 *   else if (e.key === "Enter")            the other arm of that same chain
 *
 * Counting every `e.key ===` occurrence flags all three, and a check that cries
 * wolf on correct code is worse than no check: it gets ignored, and then the
 * real duplicate ships. So the condition must be purely a key test, and an
 * `else if` is a chain continuation rather than a new binding.
 */
function keyBindings() {
    const found = [];
    const base = ENGINE.slice(0, handlerStart).split('\n').length;
    HANDLER.split('\n').forEach((line, i) => {
        if (/^\s*else\s+if/.test(line)) return;

        /*
         * Pull out the condition by counting parentheses rather than by regex.
         *
         * Two earlier attempts each looked fine and were wrong in opposite
         * directions, and both mistakes were invisible until the mutation
         * harness ran:
         *
         *   [^)]*        stopped at the ")" inside `e.key.toLowerCase()`, so the
         *                world-map binding was never seen at all.
         *   greedy .*    required a "{" after the condition, so every
         *                single-statement binding -- `if (e.key === "3")
         *                useItem(...)`, which is most of this handler -- went
         *                invisible instead.
         *
         * Counting is the boring version that does neither. A string literal
         * containing an unbalanced paren would still fool it; there are none in
         * this handler and adding a JS parser would be the real answer.
         */
        const open = /^\s*if\s*\(/.exec(line);
        if (!open) return;
        let depth = 0;
        let end = -1;
        for (let c = open[0].length - 1; c < line.length; c++) {
            if (line[c] === '(') depth++;
            else if (line[c] === ')') {
                depth--;
                if (depth === 0) { end = c; break; }
            }
        }
        if (end < 0) return;
        const cond = line.slice(open[0].length, end);
        // Every clause must be a bare key test.
        const clauses = cond.split('||').map(s => s.trim());
        const keys = [];
        for (const clause of clauses) {
            // Two spellings are in use in this file and both must be recognised:
            //   e.key === "m"                  double quotes, direct compare
            //   e.key.toLowerCase() === 'm'    single quotes, case-folded
            // The second form was added for the world-map key and the first
            // version of this matcher missed it entirely, which let "m" end up
            // bound twice -- the exact defect this file exists to catch. A
            // matcher that only knows one spelling of a comparison is not a
            // check, it is a coincidence.
            const km = /^e\.key(?:\.toLowerCase\(\))? === ["']([^"']+)["']$/.exec(clause);
            if (!km) return;                     // some other condition; not a pure key test
            keys.push(km[1]);
        }
        if (!keys.length) return;
        // `text` is kept so a check can ask what the binding actually calls,
        // not merely which key it tests.
        found.push({ keys, line: base + i, text: line.trim() });
    });
    return found;
}

function normalise(key) {
    return key.length === 1 ? key.toUpperCase() : key;
}

test('no key is handled twice in the keydown handler', () => {
    const seen = new Map();
    const duplicates = [];
    for (const b of keyBindings()) {
        // A clause may name several keys -- "ArrowUp" and "w", or "r" and "R".
        // Within one binding those are alternatives for one intent, so
        // "r"/"R" must not count as a key bound twice to itself. Deduped first,
        // then each distinct key is checked against the rest of the handler.
        const distinct = [...new Set(b.keys.map(normalise))];
        for (const k of distinct) {
            if (seen.has(k)) {
                duplicates.push(`"${k}" on line ${b.line}, already bound on line ${seen.get(k)}`);
            } else {
                seen.set(k, b.line);
            }
        }
    }
    assert.deepStrictEqual(duplicates, [],
        'these keys are bound more than once in the keydown handler, so the earlier\n' +
        '  binding always wins and the later one is dead code:\n    ' +
        duplicates.join('\n    '));
});

test('the spell keys carry a spellIndex, because the server dispatches on it', () => {
    // Removing this would not be a refactor. COMBAT.castSpell branches on
    // spellId: 1 is the class primary, anything-else is the secondary, and 3 is
    // the epic. A cast_spell with no index silently becomes the secondary.
    assert.match(HANDLER, /e\.key === "1"[^\n]*spellIndex: 1/,
        'key "1" must send spellIndex 1 (the class primary spell)');
    assert.match(HANDLER, /e\.key === "2"[^\n]*spellIndex: 2/,
        'key "2" must send spellIndex 2 (the class secondary spell)');
});

test('the epic spell keeps a binding', () => {
    // It had exactly one, and a proposed cleanup removed it. There is no button
    // for the epic, so removing the key makes it unreachable entirely.
    assert.match(HANDLER, /e\.key === "r" \|\| e\.key === "R"[^\n]*spellIndex: 3/,
        'the epic spell (spellIndex 3) must stay bound to R; it has no HUD button');
});

test('every key named on a HUD button is actually bound', () => {
    // The original defect, in the form that matters to a player: a button said
    // "Press '1'" and pressing 1 did something else. It showed up twice in two
    // different notations, so both are scanned:
    //
    //   <button ...>Purify (Press '1')</button>      key hint in the label
    //   <button ... title="Toggle sound (M)">         key hint in the tooltip
    //
    // The second one shipped: the audio button advertised M while the world-map
    // handler had already claimed M and returned, so the tooltip pointed at a
    // key that did something else entirely. The first version of this test only
    // scanned button text and would have sat green through that.
    // onclick captures as "castPurify()"; the parens are dropped so the name
    // can be matched against a function identifier. Leaving them on made
    // REACHED_INDIRECTLY.castSkill unreachable and the check reported the
    // Class Skill button as broken even though it is correct.
    const bareFn = (s) => s.replace(/\(\)$/, '');

    const buttonKeys = [];
    for (const m of HTML.matchAll(/<button[^>]*onclick="([^"]+)"[^>]*>[^<]*\(Press '(\w)'\)/g)) {
        buttonKeys.push({ key: m[2], fn: bareFn(m[1]), where: 'label' });
    }
    for (const m of HTML.matchAll(/<button[^>]*onclick="([^"]+)"[^>]*title="([^"]*?\s\(([A-Za-z0-9])\))"/g)) {
        buttonKeys.push({ key: m[3], fn: bareFn(m[1]), where: 'tooltip' });
    }
    assert.ok(buttonKeys.length > 0, 'no HUD button advertises a key, so this check found nothing');

    /*
     * "Bound" is not enough on its own. The audio button shipped claiming
     * "Toggle sound (M)" while M was bound -- to the world map. Asking only
     * whether the key is bound somewhere would have passed that, which is the
     * mutation that outlived two earlier attempts to check this file. What has
     * to hold is that the key reaches *this* button's function.
     *
     * One button is legitimately reachable without the key naming it, and it is
     * declared rather than inferred. Anything new here needs an argument in the
     * comment: the point of the map is to make a new divergence argue for itself
     * rather than pass quietly.
     */
    const REACHED_INDIRECTLY = {
        // Key 2 sends cast_spell with spellIndex 2. castSkill() sends cast_spell
        // with no index at all, and COMBAT.castSpell reads a missing index as
        // the secondary spell -- so for every class except healer the button and
        // the key land on the same spell. The healer exception is documented on
        // the button's tooltip and asserted separately below.
        castSkill: '2'
    };

    // Which key, if any, each binding line tests.
    const linesFor = (key) => {
        const want = normalise(key);
        const out = [];
        for (const b of keyBindings()) {
            if (b.keys.some(k => normalise(k) === want)) out.push(b);
        }
        return out;
    };

    const problems = [];
    for (const b of buttonKeys) {
        if (linesFor(b.key).length === 0) {
            problems.push(`"${b.key}" in the ${b.where} of ${b.fn}() is not bound at all`);
            continue;
        }
        if (REACHED_INDIRECTLY[b.fn] === b.key) continue;
        const named = linesFor(b.key).some(l => l.text.includes(b.fn));
        if (!named) {
            problems.push(`"${b.key}" in the ${b.where} of ${b.fn}()` +
                ` is bound to something else; no binding for that key calls ${b.fn}()`);
        }
    }
    assert.deepStrictEqual(problems, [],
        'these buttons advertise a key that does not reach their own function:\n  ' +
        problems.join('\n  '));
});

test('Purify is reachable from the keyboard', () => {
    // It was not, before. Its button claimed key "1" while pressing 1 cast the
    // class primary spell, so the only way to use Purify was to click.
    assert.match(HANDLER, /e\.key === "p" \|\| e\.key === "P"[^\n]*castPurify\(\)/,
        'Purify must have its own key binding, since it is otherwise click-only');
});

test('the help bar lists the keys that are bound', () => {
    // Cheap, and it is the only place a new player looks. The epic and Purify
    // were both absent from it while being bound.
    const bar = /Move: WASD[^<]*/.exec(HTML);
    assert.ok(bar, 'could not find the help bar in test_client.html');
    // Compared case-insensitively: the bar writes 'R' and 'P' uppercase while
    // the handler tests the lowercase spelling first.
    const barText = bar[0].toLowerCase();

    // Navigation and interaction keys are self-evident or documented elsewhere.
    // Stored lowercase: normalise() upper-cases, so a list written in lowercase
    // would silently stop matching and every key in it would be reported missing.
    //
    // "m" is deliberately NOT exempt any more. It used to be, because audio was
    // bound to it but undocumented. The world map has since taken M, the stale
    // audio binding has been removed, and M now has to appear in the help bar
    // like every other key a player is expected to press.
    const SELF_EVIDENT = ['w', 'a', 's', 'd', 'e', 'f', 'z', 'enter', 'escape', 'tab'];

    const missing = [];
    for (const b of keyBindings()) {
        for (const raw of b.keys) {
            const k = normalise(raw);
            if (k.length !== 1) continue;
            if (SELF_EVIDENT.includes(k.toLowerCase())) continue;
            if (barText.includes(`'${k.toLowerCase()}'`)) continue;
            missing.push(k);
        }
    }
    assert.deepStrictEqual([...new Set(missing)], [],
        'these keys are bound but not mentioned in the on-screen help bar:\n  ' +
        [...new Set(missing)].map(k => `'${k}'`).join(', '));
});

test('no HUD button name collides with a different function than its key', () => {
    // "Class Skill (Press '2')" calls castSkill, which sends a spellIndex-less
    // cast_spell; the server reads a missing index as the secondary spell. So for
    // a warrior the button and the key agree. For a healer they do not: the
    // button casts Flash Heal, the key casts Holy Smite. That divergence is real
    // and is now stated in the button's title rather than left for a player to
    // discover by noticing the button did something else.
    const html = HTML;
    assert.match(html, /onclick="castSkill\(\)"[^>]*title="[^"]*healer/i,
        'the healer divergence between the Class Skill button and key 2 should be ' +
        'documented on the button');
});