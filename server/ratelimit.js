/*
 * server/ratelimit.js
 *
 * Per-player, per-action-class budgets for inbound packets.
 *
 * Why this exists. There was exactly one rate limit on the server: a per-IP
 * login throttle, and a coarse 60-messages-per-second flood guard per
 * connection. Gameplay cooldowns covered `move` (lastMoveTime) and `attack`
 * (lastAttackTime), and `fish` and `cast_spell` carry their own. Everything else
 * was ungated, which left three problems:
 *
 *   1. `chat` was unbounded. The flood guard allows 60 a second, and each one
 *      is broadcast to every client on the floor, so one client could drive
 *      60x the traffic for everyone else.
 *   2. `/ask <prompt>` calls a local LLM. There was no timeout on the HTTP
 *      request, no cap on how many could be in flight, and no limit on prompt
 *      length, so 60 prompts a second each became an unbounded 26B inference.
 *      See server/ollama.js, which now caps the request itself; this module is
 *      the outer control that stops the packets arriving at all.
 *   3. cast_purify, cast_heal, use_item, drop_item, toggle_mount, auction_list
 *      and craft_item had no gate at all.
 *
 * Design notes that are not obvious:
 *
 * - Token bucket, not fixed window. A fixed window lets a client send its whole
 *   budget at the end of one window and again at the start of the next, which is
 *   twice the intended rate at the boundary. A bucket refills continuously, so
 *   the long-run rate is what the budget says.
 *
 * - Buckets are per (player, class), not global. One player spamming must not
 *   cost anyone else their budget, which is the whole point of a budget.
 *
 * - The map is bounded. An attacker who can authenticate can otherwise create
 *   one entry per (player, class) and never let them expire, so there is a hard
 *   ceiling and the stalest entries are evicted past it. Without this the limiter
 *   is itself the memory-exhaustion vector.
 *
 * - `consume` counts the attempt even when it is refused. Otherwise a client
 *   that is being throttled would refill its own bucket by trying again, and the
 *   limiter would stop limiting.
 */

/**
 * A token bucket that refills at `refillMs` per token and holds at most `burst`.
 *
 * @param {object}  opts
 * @param {number}  opts.burst      tokens held at full; also the ceiling on
 *                                  tokens a single call can return
 * @param {number}  opts.refillMs   milliseconds to regain one token
 * @param {number} [opts.maxKeys]   ceiling on tracked keys before eviction
 * @param {number} [opts.idleMs]    a key untouched for this long is swept
 * @param {function} [opts.now]     clock, injectable for tests
 */
function createLimiter({ burst, refillMs, maxKeys = 4096, idleMs = 120_000, now = Date.now }) {
    if (!Number.isFinite(burst) || burst < 1) throw new Error('burst must be >= 1');
    if (!Number.isFinite(refillMs) || refillMs <= 0) throw new Error('refillMs must be > 0');

    const buckets = new Map();   // key -> { tokens, updatedAt, touchedAt }

    function sweep(at) {
        for (const [key, b] of buckets) {
            if (at - b.touchedAt >= idleMs) buckets.delete(key);
        }
    }

    /**
     * Try to spend one token.
     * @returns {{allowed: boolean, retryAfterMs: number}}
     */
    function consume(key) {
        const at = now();
        let b = buckets.get(key);
        if (!b) {
            b = { tokens: burst, updatedAt: at, touchedAt: at };
            buckets.set(key, b);
        }

        // Refill for elapsed time. Capped at burst so an idle player does not
        // bank a minute of moves and then spend them in one frame.
        const elapsed = at - b.updatedAt;
        if (elapsed > 0) {
            b.tokens = Math.min(burst, b.tokens + (elapsed / refillMs));
            b.updatedAt = at;
        }
        b.touchedAt = at;

        if (b.tokens >= 1) {
            b.tokens -= 1;
            return { allowed: true, retryAfterMs: 0 };
        }

        // Refused, but the attempt still counts as activity: a client hammering
        // while limited must not refill itself by hammering.
        const deficit = 1 - b.tokens;
        return { allowed: false, retryAfterMs: Math.ceil(deficit * refillMs) };
    }

    /** Tokens currently available, for tests and diagnostics. */
    function peek(key) {
        const b = buckets.get(key);
        if (!b) return burst;
        const elapsed = now() - b.updatedAt;
        return Math.min(burst, b.tokens + (elapsed / refillMs));
    }

    /**
     * Bound the map. Called once per packet batch rather than per consume, so
     * the cost is amortised, and it only evicts once the ceiling is crossed.
     */
    function enforceCeiling(at) {
        if (buckets.size <= maxKeys) return 0;
        sweep(at);
        if (buckets.size <= maxKeys) return 0;
        // Oldest-touched first. Map preserves insertion order, but touchedAt is
        // what matters, so sort a bounded slice rather than the whole map.
        const entries = [...buckets.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
        let evicted = 0;
        for (const [key] of entries) {
            if (buckets.size <= maxKeys) break;
            buckets.delete(key);
            evicted++;
        }
        return evicted;
    }

    return { consume, peek, sweep, enforceCeiling, size: () => buckets.size, reset: () => buckets.clear() };
}

/**
 * Maps an inbound action to its budget class.
 *
 * Anything not listed is `other`, which is deliberately generous: the flood
 * guard already caps raw packet rate, and a wrong guess here would throttle a
 * legitimate feature. The classes exist for packets that cost the server
 * something out of proportion to their frequency -- broadcast, inference, or a
 * persistent write.
 */
const ACTION_CLASSES = {
    // Broadcasts to every client on the floor, so one client multiplies traffic.
    chat: 'chat',
    say: 'chat',
    whisper: 'chat',

    // Inference. The tightest budget on the server by a wide margin.
    ask: 'llm',

    // Mana is already checked server-side, but the request still costs a round
    // trip and a spell animation broadcast.
    cast_spell: 'spell',
    cast_purify: 'spell',
    cast_heal: 'spell',
    cast_meteor: 'spell',
    cast_nova: 'spell',

    // Inventory churn. Each one rewrites and persists the character row.
    use_item: 'item',
    drop_item: 'item',
    pickup: 'item',

    // Economy: persistent writes, and the ones with money attached.
    auction_list: 'economy',
    auction_buy: 'economy',
    auction_cancel: 'economy',
    bank_deposit_gold: 'economy',
    bank_withdraw_gold: 'economy',
    bank_deposit_item: 'economy',
    bank_withdraw_item: 'economy',
    craft_item: 'economy',

    // Trade and guild calls are relayed to another player, so a spam is a spam
    // at someone else's client.
    trade_request: 'social',
    trade_lock: 'social',
    trade_confirm: 'social',
    invite_guild: 'social',
    invite_party: 'social',
    emote: 'social',

    // Friend list (roadmap 6.2). A mutation rewrites and persists the character row,
    // the same reason the item and economy classes are budgeted rather than left on
    // the generic catch-all -- and a list request is answered from that same list,
    // so all three share one budget.
    friend_add: 'social',
    friend_remove: 'social',
    friend_list_request: 'social'
};

function classFor(action) {
    return ACTION_CLASSES[action] || 'other';
}

module.exports = { createLimiter, classFor, ACTION_CLASSES };