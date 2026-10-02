/*
 * server/whisper.js
 *
 * Private messages between two players (roadmap 6.1).
 *
 * WHY THIS IS SERVER-ONLY
 *
 * The client sends `data.text` to the server verbatim -- engine.js only strips a
 * /p, /z or /g prefix and otherwise relays whatever was typed. So a player typing
 *
 *     /w Alice hello
 *
 * into the existing chat box already sends the literal string "/w Alice hello" to
 * the server, which is enough to implement whispering without touching a single
 * client file. That matters here: the frontend session has uncommitted work in
 * engine.js and ui.js, and a whisper branch that only parsed a `channel: 'whisper'`
 * packet would have required editing both of them to be usable at all.
 *
 * A `channel: 'whisper'` packet with an explicit `targetName` is also accepted, for
 * clients that would rather send it that way. Nothing in this server produces one.
 *
 * WHY A MODULE
 *
 * The interesting part is validation: an offline target, an empty message, a
 * self-whisper, and the prefix that must not match /wave. None of that can be
 * tested by importing server.js, which starts a server on require.
 */

const MAX_LENGTH = 240;

/**
 * Pull a whisper out of a chat line.
 *
 * Only `/w ` counts, with the space. Matching a bare `/w` would swallow `/wave` and
 * `/wands`, and a player trying to type a sentence starting with that would get a
 * confusing error instead of their message.
 *
 * @param {string} text
 * @returns {{target: string, message: string}|null} null if this is not a whisper
 */
function parse(text) {
    if (typeof text !== 'string') return null;
    if (!text.startsWith('/w ')) return null;

    const rest = text.substring(3).trim();
    if (!rest) return null;

    // Split on the first run of whitespace: a name cannot contain a space, but the
    // message can contain any number of them.
    const split = rest.search(/\s/);
    if (split === -1) return null;                    // "/w Alice" -- a name and no message

    const target = rest.substring(0, split).trim();
    const message = rest.substring(split).trim();
    if (!target || !message) return null;

    return { target, message };
}

/**
 * Deliver a whisper, or explain why it could not be delivered.
 *
 * Every failure is reported to the sender only. A recipient is never told that a
 * stranger tried to reach them, and no outcome reveals whether a given name is
 * online to anyone but its owner.
 *
 * @param {object} ctx
 * @param {string} ctx.text          the raw chat line
 * @param {string} ctx.senderName    the sender's character name
 * @param {(name: string) => object|null} ctx.lookup  case-insensitive online lookup
 * @param {(player: object, packet: object) => void} ctx.sendTo
 * @param {(player: object, message: string) => void} ctx.notify  private log line
 * @returns {{handled: boolean, outcome: string, target?: string, reason?: string}}
 */
function whisper(ctx) {
    const parsed = parse(ctx.text);
    if (!parsed) return { handled: false, outcome: 'not-a-whisper' };

    const { target, message } = parsed;
    const body = message.length > MAX_LENGTH ? message.slice(0, MAX_LENGTH) : message;

    const recipient = ctx.lookup(target);

    if (!recipient) {
        // Deliberately not naming whether the character exists at all. "is online"
        // is the only fact leaked, and only to someone who could have guessed the
        // name anyway -- but the message does not distinguish "never existed" from
        // "logged off", so an offline roster is not enumerable by script.
        ctx.notify(ctx.sender, 'Nobody online is called ' + target + '.');
        return { handled: true, outcome: 'no-such-player', target };
    }

    if (recipient.charName && recipient.charName.toLowerCase() === String(ctx.senderName).toLowerCase()) {
        ctx.notify(ctx.sender, 'You cannot whisper yourself.');
        return { handled: true, outcome: 'self', target };
    }

    const packet = {
        action: 'chat',
        channel: 'whisper',
        sender: ctx.senderName,
        name: ctx.senderName,
        text: body,
        target: recipient.charName,
        timestamp: Date.now()
    };

    // To the recipient first. If sending to one of them throws, the sender's own
    // echo is not delivered either, which is the right way round: the sender should
    // never see confirmation of a message that was not delivered.
    ctx.sendTo(recipient, packet);

    // Echoed to the sender so they can see what went out. Tibia does this, and a
    // one-sided send would leave the sender unable to tell a delivered whisper from
    // one the server swallowed.
    ctx.sendTo(ctx.sender, Object.assign({}, packet, { outbound: true }));

    return { handled: true, outcome: 'sent', target: recipient.charName };
}

module.exports = { parse, whisper, MAX_LENGTH };
