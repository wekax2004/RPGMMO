/*
 * server/friends.js
 *
 * The friend list (roadmap 6.2).
 *
 * Pure logic over an array of names. No sockets, no database, no clock. Every
 * decision that can be wrong -- what a legal name is, whether a name may be added
 * twice, what happens when the list is full -- lives here so it can be tested
 * without a server, which is the same reason ratelimit.js and aoi.js are shaped this
 * way.
 *
 * WHY THE NAME CHARSET IS ENFORCED HERE AND NOT ONLY AT LOGIN
 *
 * A friend entry is a character name that came from another player. It travels:
 * server -> friends_list packet -> renderChat/renderFriends -> innerHTML. The client
 * escapes it, and escapeHtml covers `& < > ' "`, so the client is not the weak link.
 * But the name also reaches the packet payload, and a friend list is exactly the sort
 * of field a client should never have to trust. So an entry that could not have been
 * created by logging in is refused at the point it is added, and again when a save is
 * loaded.
 *
 * The alternative -- accepting anything and relying on the client's escaper -- is how
 * a stored XSS happens the first time somebody adds a field and forgets it.
 *
 * WHY ONLINE STATUS IS NOT STORED
 *
 * It is computed from the live player list on every send. Storing it would mean every
 * friend list on the server goes stale the moment someone logs off, and the only way
 * to fix that is a broadcast on every connect and disconnect.
 */

const CFG = require('./config');

// Must match the charset the login handler accepts. If that widens, this has to widen
// with it -- tests/unit/friends.test.js asserts they are the same pattern, precisely
// so the two cannot drift apart silently.
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]*$/;
const NAME_MAX_LENGTH = 32;

/**
 * Is this a string that could name a character?
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isLegalName(name) {
    return typeof name === 'string'
        && name.length > 0
        && name.length <= NAME_MAX_LENGTH
        && NAME_PATTERN.test(name);
}

/**
 * Reduce any stored value to a list of legal, unique names, preserving order.
 *
 * Used on every load, so a hand-edited or partially written save cannot inject a
 * malformed entry that later throws inside a render or a comparison. Same reasoning as
 * the quest sanitiser in normalizePlayerData: trust the shape, rebuild the content.
 *
 * @param {unknown} stored
 * @returns {string[]}
 */
function sanitize(stored) {
    if (!Array.isArray(stored)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of stored) {
        // Only the trimmed form is kept, so " Bob " and "Bob" cannot both sit in the
        // list looking like two people.
        const name = typeof raw === 'string' ? raw.trim() : '';
        if (!isLegalName(name)) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
        if (out.length >= CFG.FRIENDS_MAX) break;
    }
    return out;
}

/**
 * Add a friend.
 *
 * @param {string[]} existing  the current list (not assumed to be sanitised)
 * @param {unknown} rawName    the name from the packet
 * @param {object} opts
 * @param {string}  opts.selfName     the caller's own character name
 * @param {string[]} opts.existingNames  names known to exist, if the caller already has them
 * @param {boolean} opts.exists       resolved existence, preferred over the list.
 *   The server resolves this against the database rather than the live player map,
 *   because the live map only holds connected characters -- and adding someone who is
 *   offline is the normal case, not an edge case. The first version passed the online
 *   list here and refused every friend you added after they logged off.
 * @returns {{ok: boolean, reason: string, list: string[]}}
 */
function add(existing, rawName, opts = {}) {
    const list = sanitize(existing);
    const name = typeof rawName === 'string' ? rawName.trim() : '';

    if (!isLegalName(name)) {
        return { ok: false, reason: 'not-a-name', list };
    }
    // Case-insensitively, because two entries differing only in case would render as
    // two different friends to a human and as one to a lookup.
    const key = name.toLowerCase();
    if (String(opts.selfName || '').toLowerCase() === key) {
        return { ok: false, reason: 'self', list };
    }
    if (list.some(f => f.toLowerCase() === key)) {
        return { ok: false, reason: 'already-friends', list };
    }
    if (list.length >= CFG.FRIENDS_MAX) {
        return { ok: false, reason: 'list-full', list };
    }
    // The character must exist. Refusing here means the list only ever holds real
    // characters, so nothing downstream has to cope with a name that resolves to
    // nobody -- and a player cannot fill their list with entries that exist to be
    // spammed at whoever picks that name.
    if (typeof opts.exists === 'boolean') {
        if (!opts.exists) return { ok: false, reason: 'no-such-character', list };
    } else if (Array.isArray(opts.existingNames) &&
        !opts.existingNames.some(n => String(n).toLowerCase() === key)) {
        return { ok: false, reason: 'no-such-character', list };
    }

    return { ok: true, reason: 'added', list: [...list, name] };
}

/**
 * Remove a friend.
 *
 * Refuses on a name that is not present rather than reporting success, so the caller
 * can tell the player something useful. Removing someone who was never a friend is
 * not an error worth a modal, but it must not be silently reported as a removal.
 *
 * @param {string[]} existing
 * @param {unknown} rawName
 * @returns {{ok: boolean, reason: string, list: string[]}}
 */
function remove(existing, rawName) {
    const list = sanitize(existing);
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!isLegalName(name)) {
        return { ok: false, reason: 'not-a-name', list };
    }
    const key = name.toLowerCase();
    const next = list.filter(f => f.toLowerCase() !== key);
    if (next.length === list.length) {
        return { ok: false, reason: 'not-a-friend', list };
    }
    return { ok: true, reason: 'removed', list: next };
}

/**
 * The friends_list payload.
 *
 * Online status is resolved here, against the live player list, rather than stored.
 *
 * @param {string[]} list
 * @param {string[]} onlineNames  the character names currently connected
 * @returns {Array<{name: string, online: boolean}>}
 */
function describe(list, onlineNames) {
    const online = new Set((Array.isArray(onlineNames) ? onlineNames : []).map(n => String(n).toLowerCase()));
    return sanitize(list).map(name => ({ name, online: online.has(name.toLowerCase()) }));
}

/** Human-readable text for each refusal, so the player is told something. */
const MESSAGES = {
    'not-a-name': 'That is not a character name.',
    self: 'You cannot add yourself.',
    'already-friends': 'They are already on your list.',
    'list-full': 'Your friend list is full.',
    'no-such-character': 'No character by that name exists.',
    'not-a-friend': 'They are not on your friend list.'
};

module.exports = {
    add, remove, describe, sanitize, isLegalName,
    NAME_PATTERN, NAME_MAX_LENGTH, MESSAGES
};
