/*
 * tests/unit/xss_sinks.test.js
 *
 * Server-supplied strings reach the DOM as markup in this client, so every one
 * of them has to be escaped on the way in. This file makes that a rule instead
 * of a habit.
 *
 * Why it exists. The auction house renderer interpolated the seller's character
 * name straight into innerHTML:
 *
 *     (Seller: ${item.sellerName})
 *
 * and character names are validated on the server only as "a non-empty string"
 * -- database.js:186 checks `charName.trim().length === 0` and nothing else.
 * An account username cannot contain markup (auth.js:51 pins it to
 * ^[a-z0-9][a-z0-9_.-]{2,31}$), but a character name can. So anyone who could
 * make a character named `<img src=x onerror=...>` and list a single item got
 * script execution in every other player's browser the moment they opened the
 * auction house. Stored, self-service, and it reached the whole player base.
 *
 * The rule below is deliberately blunt: a template-literal interpolation that
 * reaches HTML must be wrapped in an escaping or numeric call, or be named on a
 * short allowlist of values that cannot carry markup. An allowlist entry is a
 * claim that has to be argued in a comment, so "I already escaped this one
 * somewhere else" cannot quietly become the default answer.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FILES = ['ui.js', 'engine.js'].map(f => ({
    name: f,
    src: fs.readFileSync(path.join(ROOT, 'client', 'js', f), 'utf8')
}));

// Wrappers that make an interpolation safe to emit as markup.
const SAFE_CALL = /\b(escapeHtml|Number|parseInt|parseFloat|Math\.|toFixed|Intl\.)\b/;

/*
 * Values that are safe unescaped, each with the reason. Kept short on purpose:
 * every entry is an assertion that this identifier is numeric or already-escaped
 * at its definition site, and adding to this list should be rarer than adding an
 * escapeHtml.
 */
const ALLOWED_BARE = new Map([
    // Pre-escaped in engine.js: `const escK = escapeHtml(k).replace(/'/g, '&#39;')`.
    ['escK', 'already escaped at definition, then quote-escaped for the attribute'],
    ['escS', 'already escaped at definition'],
    // Counts and indices derived from array lengths.
    ['pct', 'numeric percentage, computed then clamped'],
    ['qty', 'stack count'],
    ['miss.have', 'recipe progress count'],
    ['miss.required', 'recipe requirement count'],
    ['counts[k]', 'stack count'],
    ['counts[item]', 'stack count'],
    ['vcounts[item]', 'stack count'],
    ['item.price', 'coerced with Number() and falls back to 0'],
    // Presentation flags and colours chosen from fixed sets in this file.
    ['maxed', 'a literal " maxed" or empty string'],
    ['color', 'a literal picked from a fixed list in this module'],
    ['opacity', 'computed number'],
    ['disabled', 'literal attribute string'],
    ['status', 'literal status text built from fixed strings'],
    ['inputs', 'built from recipe input counts, not from names'],
    ['detail', 'built from miss.have/miss.required, both counts'],
    // Numeric item stats from the server's item table. getItemStats returns
    // this as a plain string and it is escaped on arrival by showTooltip
    // (ui.js:783-785 runs every part through escapeHtml), so it never becomes
    // markup here. The numbers are what is interpolated; the labels are fixed.
    ['itm.bonus', 'numeric weapon damage from the item table'],
    ['itm.def', 'numeric armour defence from the item table'],
    ['itm.speedBonus', 'numeric boots speed bonus'],
    ['itm.maxHpBonus', 'numeric amulet HP bonus'],
    ['itm.val', 'numeric potion restore amount'],
    ['skill.level', 'numeric skill level'],
    ['skill.name', 'server-authored skill label, not player input'],
    ['data.gold', 'numeric gold count'],
    ['data.name', 'server-authored mob/NPC name'],
    ['data.item', 'server-authored item or fish name']
]);

/*
 * Only functions that actually write HTML are scanned.
 *
 * A first version flagged every `${...}` in both files and produced ten
 * findings, of which one was real. The rest were a tooltip string that
 * showTooltip escapes downstream, a CSS selector built for querySelector, and
 * chat text destined for innerText. None of them become markup, and a check
 * that reports correct code as a vulnerability gets ignored -- which is how the
 * auction bug survived in the first place.
 *
 * So the unit of scanning is the function, and a function qualifies only if it
 * assigns to .innerHTML somewhere in its body.
 */
function htmlWritingChunks(src) {
    const lines = src.split('\n');
    // Function starts in the shapes these two files use.
    const starts = [];
    lines.forEach((line, i) => {
        if (/^\s*(?:window\.)?[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?function\b/.test(line)) starts.push(i);
        else if (/^\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(line)) starts.push(i);
        else if (/^\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(/.test(line)) starts.push(i);
    });
    if (!starts.length) return [];

    const out = [];
    starts.forEach((from, k) => {
        const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
        const body = lines.slice(from, to);
        if (!body.some(l => /\.innerHTML\s*(=|\+=)/.test(l))) return;
        body.forEach((line, i) => {
            for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
                out.push({ expr: m[1].trim(), line: from + i + 1, text: line.trim(), kind: 'interpolation' });
            }
        });
    });
    return out;
}

/*
 * NOT attempted: a general rule for string concatenation.
 *
 * Concatenation is the other way a value reaches markup -- the guild member list
 * used `h += "- " + m + "<br/>"` -- and a first attempt to catch it produced 80
 * findings, of which none were real. Two reasons it does not work here:
 *
 *   engine.js is one packet handler for the whole protocol, so "the function that
 *   writes innerHTML" is the entire file. Every `a + b` in it qualifies,
 *   including arithmetic, getElementById arguments and innerText assignments.
 *   and backtracking makes the match itself wrong: against `+ escapeHtml(m)` a
 *   regex will happily settle for `escapeHtm`, because `l` is not a delimiter it
 *   was told to reject.
 *
 * Deciding whether a concatenation reaches innerHTML needs dataflow, not regex.
 * The compensating control is the pinned assertions below, which cover every
 * concatenation sink that carries player-chosen text -- guild member, party
 * member, guild inviter, trade-request sender -- so a regression at one of those
 * specific places still fails the build.
 */

// A ternary whose every branch is a literal or a numeric read carries no markup.
function literalOnlyTernary(expr) {
    if (!expr.includes('?')) return false;
    return expr.split('?').slice(1).every(part => {
        const branches = part.split(':');
        return branches.every(b => {
            const t = b.trim();
            if (/^['"`].*['"`]$/.test(t)) return true;
            return /^(Number|parseInt|parseFloat)\(|^\w+(\.\w+)*\.(length|bonus|def|speedBonus|maxHpBonus|val)$/.test(t) || /^-?\d+(\.\d+)?$/.test(t);
        });
    });
}

test('no unescaped value reaches HTML', () => {
    const problems = [];
    for (const f of FILES) {
        for (const { expr, line, text, kind } of htmlWritingChunks(f.src)) {
            if (SAFE_CALL.test(expr)) continue;
            if (ALLOWED_BARE.has(expr)) continue;
            if (/^['"`].*['"`]$/.test(expr)) continue;
            if (literalOnlyTernary(expr)) continue;
            const shown = kind === 'interpolation' ? `\${${expr}}` : `+ ${expr}`;
            problems.push(`${f.name}:${line}  ${shown}\n      ${text.slice(0, 110)}`);
        }
    }
    assert.deepStrictEqual(problems, [],
        'these values reach innerHTML without escaping, by interpolation or by\n' +
        'concatenation. If the value can be influenced by a player this is script\n' +
        'execution; escape it with escapeHtml or coerce it with Number():\n  ' +
        problems.join('\n  '));
});

test('the concatenation sinks that carry player names stay escaped', () => {
    // These build their HTML with `+` rather than `${}`, so the general
    // interpolation rule cannot see them. Each one renders a name a player
    // chose, so each is pinned individually.
    const ui = FILES.find(f => f.name === 'ui.js').src;
    const engine = FILES.find(f => f.name === 'engine.js').src;

    const pinned = [
        {
            file: 'engine.js', src: engine,
            what: 'the guild member list',
            expect: /myGuild\.members\.forEach\(m => h \+= "- " \+ escapeHtml\(m\)/
        },
        {
            file: 'engine.js', src: engine,
            what: 'the guild name and leader line',
            expect: /escapeHtml\(myGuild\.name\)/
        },
        {
            file: 'engine.js', src: engine,
            what: 'the subclass card id used inside an onclick attribute',
            expect: /subclass-card-" \+ escapeHtml\(id\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the pending party inviter',
            expect: /\+ escapeHtml\(pendingPartyInvite\.inviter\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the pending guild inviter',
            expect: /\+ escapeHtml\(pendingGuildInvite\.inviter\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the guild member row',
            expect: /\+ escapeHtml\(member\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the dialogue body text',
            expect: /\+ escapeHtml\(data\.text \|\| ''\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the legacy quest name and description',
            expect: /\+ escapeHtml\(q\.name\)/
        },
        {
            file: 'ui.js', src: ui,
            what: 'the tooltip parts',
            expect: /tooltip-title'>" \+ escapeHtml\(title\)/
        }
    ];

    const broken = pinned.filter(p => !p.expect.test(p.src))
        .map(p => `${p.file}: ${p.what}`);
    assert.deepStrictEqual(broken, [],
        'these sinks render player-chosen text by concatenation and have lost their\n' +
        'escapeHtml call:\n  ' + broken.join('\n  '));
});

test('the auction renderer escapes the seller name, item and id', () => {
    // Pinned individually because it is the sink that was exploitable, and
    // because "some other escapeHtml elsewhere in the file" is not a defence.
    const ui = FILES.find(f => f.name === 'ui.js').src;
    const fn = /window\.renderAuctionUI[\s\S]*?\n        \};/.exec(ui);
    assert.ok(fn, 'could not find renderAuctionUI in ui.js');

    assert.match(fn[0], /\$\{escapeHtml\(item\.sellerName\)\}/,
        'sellerName is a player-chosen character name and must be escaped');
    assert.match(fn[0], /\$\{escapeHtml\(item\.item\)\}/,
        'the item name must be escaped');
    assert.match(fn[0], /\$\{escapeHtml\(item\.id\)\}/,
        'the listing id lands inside an onclick attribute and must be escaped');
    assert.match(fn[0], /Number\(item\.price\)/,
        'the price should be coerced with Number(), not interpolated raw');
});

test('chat is rendered as text, not markup', () => {
    // Chat carries the most player-controlled text of anything on screen --
    // combat.js and bosses.js interpolate charName into log messages. It is
    // safe only because renderChat assigns innerText. One innerHTML here would
    // turn every kill message into an injection point.
    const ui = FILES.find(f => f.name === 'ui.js').src;
    const fn = /function renderChat\(\)[\s\S]*?\n        \}/.exec(ui);
    assert.ok(fn, 'could not find renderChat in ui.js');
    assert.match(fn[0], /\.innerText\s*=/,
        'chat lines must be written with innerText');
    assert.ok(!/\.innerHTML\s*\+=/.test(fn[0]),
        'chat must not accumulate markup across lines');
});

test('character names are not validated beyond being non-empty', () => {
    // This is the root cause behind the auction finding, recorded here so that
    // closing the client sink does not quietly look like closing the hole. The
    // client escape is the defence that matters; the missing server validation
    // is why the string was dangerous in the first place.
    const db = fs.readFileSync(path.join(ROOT, 'server', 'database.js'), 'utf8');
    const guard = /charName\.trim\(\)\.length === 0/.test(db);
    assert.ok(guard, 'expected the non-empty character-name guard to still be present');
});