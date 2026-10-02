const parsedPort = Number.parseInt(process.env.PORT, 10);

module.exports = {
    PORT: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 8080,
    // Loopback by default. A game server reached from every interface is
    // reachable by anything else on the network, and with auth enabled that
    // puts the scrypt login path on the open. Set HOST=0.0.0.0 deliberately
    // (for example for a Tailscale QA session) rather than by accident.
    HOST: process.env.HOST || '127.0.0.1',
    
    // גבולות מפה (בפיקסלים) - עולם פתוח גדול
    MAP_WIDTH: 3200,
    MAP_HEIGHT: 3200,
    TILE_SIZE: 32,

    // --- Z-levels (Stage 0: coordinate exists, only the surface is built) ---
    // The world is stacked floors. 0 is the surface; negative values are
    // underground. Stage 0 introduces the coordinate and the range guards but
    // generates no floor below 0, so every query for another floor answers
    // "nothing there" rather than guessing. Populating floors is a later stage.
    Z_SURFACE: 0,
    // Inclusive bounds. A save or packet carrying z outside this range is
    // treated as corrupt and clamped back to the surface, so a hand-edited
    // database can never strand a character on a floor that does not exist.
    Z_MIN: -3,
    Z_MAX: 0,

    // --- Z-levels (Stage 2: traversal and the first underground floor) ---
    // The floors below the surface, shallowest first. A table rather than a
    // single hard-coded dungeon, because one special case does not demonstrate
    // that the traversal, roster, bounds and respawn machinery is general -- it
    // only shows it works once. Each row is self-contained: shape, difficulty,
    // population, and how it connects to the floor above.
    //
    // `entrance` is where a player descending from the floor above arrives, in
    // world pixels on THIS floor. It is stated rather than derived because the
    // floors are not vertically aligned: the surface ladder is in the city at
    // (288,288) and the crypt is at (1024,1024), so arrival cannot default to
    // the tile that was stepped on.
    Z_FLOORS: [
        {
            z: -1,
            name: 'The Bone Crypt',
            originX: 1024, originY: 1024,
            tilesW: 14, tilesH: 14, pillars: 6,
            mobCount: 9, tier: 2.5, eliteChance: 0.25,
            mobTypes: ['skeleton', 'spider', 'minotaur', 'bandit'],
            chestCount: 3,
            // How this floor is entered from above, and the tile a climb from
            // below arrives on. The surface ladder leads here.
            descendsVia: 'ladder'
        },
        {
            z: -2,
            name: 'The Molten Depths',
            originX: 2048, originY: 1920,
            tilesW: 20, tilesH: 20, pillars: 12,
            mobCount: 14, tier: 4, eliteChance: 0.4,
            mobTypes: ['minotaur', 'skeleton', 'bear'],
            chestCount: 2,
            // Reached from the Molten Depths by its own stair tile. The stair is a
            // separate tile type from the surface's ladder on purpose: a ladder is
            // something you climb down, a stair is a threshold you walk through, and
            // conflating them was what made the two-floor traversal ambiguous.
            descendsVia: 'stairs'
        },
        {
            z: -3,
            name: 'The Frostmaw Warren',
            originX: 2816, originY: 1024,
            tilesW: 16, tilesH: 16, pillars: 9,
            // Tier 5.5 and a 0.55 elite chance: this is the floor a level-appropriate
            // character is not supposed to survive casually, which is what makes it
            // worth descending to. The Molten Depths at tier 4 is the last floor a
            // mid-game character can clear unaided.
            mobCount: 16, tier: 5.5, eliteChance: 0.55,
            mobTypes: ['yeti', 'bear', 'minotaur', 'skeleton'],
            chestCount: 4,
            // The deepest floor. Nothing below it, so the stair from the Molten
            // Depths is the only way on and the way back is the same tile.
            descendsVia: null
        }
    ],

    // The dungeon is a deliberately small generated cave, not hand-authored
    // content. It exists to prove the traversal loop end to end.
    Z_DUNGEON: -1,
    // Cave footprint, in tiles, and its world-space origin. Kept inside the
    // map and far enough from the safe zone that surface play is unaffected.
    DUNGEON_ORIGIN_X: 1024,
    DUNGEON_ORIGIN_Y: 1024,
    DUNGEON_TILES_W: 14,
    DUNGEON_TILES_H: 14,
    DUNGEON_PILLARS: 6,
    // The surface ladder, in world pixels. Inside the safe zone on purpose: a
    // traversal mechanic nobody can find is the same as no mechanic, and this
    // is the one place a new player is guaranteed to walk.
    LADDER_X: 288,
    LADDER_Y: 288,
    // Traversal is walked onto, so a tile that leads nowhere must not be a
    // trap. A ladder the player cannot return up from is a dead character, so
    // the arrival search guarantees a walkable landing tile.
    ARRIVAL_SEARCH_RINGS: 6,
    // Chat crosses floors (party and guild are social, not positional). Trade,
    // targeting, combat and loot do not -- all of those use dist3D, which
    // returns Infinity across a floor boundary.

    // --- Z-levels (Stage 3: the dungeon is inhabited) ---
    // How many mobs live below, and how much tougher they are than their
    // surface namesakes. The tier multiplies existing types rather than adding
    // new ones, so a dungeon skeleton is the same skeleton scaled: it keeps its
    // sprite, its loot table and its quest identity, and none of the surface
    // economy shifts.
    // Nine, in a 12x12 cave, is roughly one mob per twenty tiles. The first
    // pass used fourteen and a level 1 character standing still in the room was
    // killed faster than any heal could land -- several mobs land a hit per
    // server tick, so topping up between steps loses the race outright. Lethal
    // is correct for a dungeon; unsurvivable-by-arrival is not.
    DUNGEON_MOB_COUNT: 9,
    DUNGEON_MOB_TIER: 2.5,
    // Elites are doubled on top of the tier. More common underground than on
    // the surface, where it is 0.1.
    DUNGEON_ELITE_CHANCE: 0.25,
    // Underground roster. A surface bear wandering into a cave would be both
    // wrong and, with the tier applied, a wall.
    DUNGEON_MOB_TYPES: ['skeleton', 'spider', 'minotaur', 'bandit'],
    // Top the dungeon back up to DUNGEON_MOB_COUNT on this interval, so a
    // player who clears it does not permanently empty the floor.
    DUNGEON_RESPAWN_INTERVAL: 30_000,
    // Chests below. More valuable than the surface ones, since getting there
    // is the point of the floor.
    DUNGEON_CHEST_COUNT: 3,
    DUNGEON_CHEST_GOLD: 150,

    // Safe Zone (City)
    SAFE_ZONE: { x: 0, y: 0, w: 640, h: 640 },

    // קצב תנועה
    PLAYER_MOVE_COOLDOWN_BASE: 300,
    MOB_MOVE_COOLDOWN: 800,

    // קרב
    PLAYER_ATTACK_COOLDOWN: 2000, 
    MOB_ATTACK_COOLDOWN: 1500,
    MELEE_RANGE: 48,
    RANGED_RANGE: 160,

    // התפתחות
    XP_BASE: 100,           
    XP_MULTIPLIER: 1.5,     
    MOB_KILL_XP: 25,        

    // קסמים
    PURIFY_MANA_COST: 20,
    SKILL_MANA_COST: 30, 
    MANA_REGEN_PER_TICK: 5,
    SAFEZONE_HEAL_PER_TICK: 5, // ריפוי אוטומטי בעיר

    // חפצים
    MAX_CHESTS: 30,
    CHEST_SPAWN_INTERVAL: 10000,
    CHEST_GOLD_REWARD: 50,

    // Epic area spells. Deliberately expensive and slow so they cannot be
    // spammed; every value is server-side and never taken from the client.
    EPIC_SPELL_MANA_COST: 60,
    EPIC_SPELL_COOLDOWN_MS: 6000,
    METEOR_STRIKE_RADIUS: 220,
    METEOR_STRIKE_DAMAGE: 140,       // plus a per-level component
    HOLY_NOVA_RADIUS: 180,
    HOLY_NOVA_HEAL: 90,              // plus a per-level component
    HOLY_NOVA_DAMAGE: 70,            // plus a per-level component

    // Ground loot: items a player sets down on the map.

    // Ground loot: items a player sets down on the map.
    GROUND_ITEM_TTL_MS: 180000,      // despawn after 3 minutes
    GROUND_PICKUP_RANGE: 64,         // matches the corpse interaction range
    GROUND_SWEEP_INTERVAL: 10000,
    // Hard cap so a mass drop_item spam cannot grow the Map without bound.
    GROUND_MAX_ITEMS: 500,

    // Corpses. A corpse used to carry an expireAt that nothing ever read, so
    // they accumulated forever and old kills stayed permanently lootable.
    // Env-tunable so a test can use a short TTL instead of waiting two minutes.
    CORPSE_TTL_MS: Number(process.env.TIBIA_CORPSE_TTL_MS) > 0
        ? Number(process.env.TIBIA_CORPSE_TTL_MS)
        : 120000,
    CORPSE_SWEEP_INTERVAL: Number(process.env.TIBIA_CORPSE_SWEEP_MS) > 0
        ? Number(process.env.TIBIA_CORPSE_SWEEP_MS)
        : 15000,

    // Mounts. MOUNT_MOVE_COOLDOWN_REDUCTION is subtracted from the same move
    // cooldown the server validates against, so a mounted client moving at the
    // faster rate is never rubber-banded back.
    MOUNT_MOVE_COOLDOWN_REDUCTION: 140,
    MOUNT_MAX_PLAYERS_PER_TILE: 0,   // 0 disables the stack limit

    // Fishing.
    FISHING_COOLDOWN_MS: 2500,
    FISHING_RANGE: 32,               // one tile; must stand within reach of water
    FISHING_CATCH_CHANCE: 0.65,      // otherwise you pull up an Old Boot

    // Per-player, per-class packet budgets. Token bucket: `burst` tokens held
    // at full, one token regained every `refillMs`. See server/ratelimit.js for
    // why this is a bucket and not a fixed window.
    //
    // These are abuse controls, not gameplay rules. Movement and attacks are
    // limited by their own cooldowns and are deliberately NOT budgeted here --
    // double-limiting them would make the existing tuning unobservable.
    //
    // Every value is server-side and overridable by environment variable, so a
    // load test or a busy shard can be tuned without a code change.
    RATE_LIMITS: {
        // Chat is broadcast to the whole floor, so one client multiplies the
        // traffic for everyone else. A human types in bursts; 6 immediately and
        // one per 1.2s covers that without letting anyone be a broadcast relay.
        chat:      { burst: 6,  refillMs: 1200 },

        // `/ask` starts a local LLM inference, which is orders of magnitude more
        // expensive than anything else a client can ask for. Deliberately
        // awkward: enough to use the feature, not enough to queue a GPU.
        llm:       { burst: 1,  refillMs: 15_000 },

        // Mana is validated server-side already; this bounds the request rate.
        spell:     { burst: 3,  refillMs: 1000 },

        // Each rewrites and persists the character row.
        item:      { burst: 8,  refillMs: 800 },
        economy:   { burst: 10, refillMs: 2000 },

        // Relayed to another player, so the cost lands on someone else's client.
        social:    { burst: 6,  refillMs: 2000 },

        // Everything else. The 60/s flood guard is the backstop.
        other:     { burst: 60, refillMs: 17 }
    },

    // Told to the client when it is throttled, so being rate limited is visible
    // rather than looking like a dropped packet. Re-sent at most this often, so
    // a client stuck in a spam loop is not told off 60 times a second.
    RATE_LIMIT_MESSAGE: 'Slow down.',
    RATE_LIMIT_NOTICE_COOLDOWN_MS: 1500,

    // Auction house.
    AUCTION_MIN_PRICE: 1,
    AUCTION_MAX_PRICE: 1000000,
    AUCTION_FEE_PERCENT: 0.05,       // taken from the seller on a successful sale
    AUCTION_MAX_LISTINGS: 200,
    AUCTION_LISTING_TTL_MS: 7 * 24 * 60 * 60 * 1000,
    AUCTION_REFUND_ITEM_MS: 24 * 60 * 60 * 1000,  // unsold item returns to the seller
    
    // מוות
    DEATH_GOLD_PENALTY: 0.5,
    MOB_KILL_GOLD: 20,

    // סטטוסים
    POISON_CHANCE: 0.4,
    POISON_TICK_INTERVAL: 3000,
    POISON_DMG_PER_STACK: 2,

    BLEED_CHANCE: 0.35,
    BLEED_TICK_INTERVAL: 2000,
    BLEED_DMG_BASE: 3,
    BLEED_MOVE_MULT: 2,

    STUN_CHANCE: 0.2,
    STUN_DURATION: 3000,

    // שידור
    STATUS_BROADCAST_INTERVAL: 300,
    PLAYER_BROADCAST_INTERVAL: 200,

    // Area of interest for the player roster (roadmap 7.2).
    //
    // Each client is sent only the players within this radius of itself, on its own
    // floor, instead of the whole floor. Two reasons 1000:
    //
    //   - The camera is 640x480 (SCREEN_W/2 = 320, SCREEN_H/2 = 240), so the furthest
    //     visible point is sqrt(320^2 + 240^2) = 400px away. 1000 leaves generous
    //     margin for the player running off-centre before a peer drops out of the set.
    //   - The minimap already filters other players at MINIMAP_RADIUS, which is 1000
    //     (renderer.js:661). Using the same number means AoI cannot change what the
    //     player sees on the minimap, and there is no second number to keep in sync.
    //
    // Set to 0 to restore the old behaviour of sending the entire floor. That is
    // slower and is the pre-AoI path, kept so the optimisation can be turned off
    // without a code change if a future feature turns out to need a global roster.
    //
    // The env override exists so a harness can measure both paths against each
    // other rather than trusting a number calculated on paper. TIBIA_AOI_RADIUS=0
    // is how tests/bots/aoi_probe.js establishes its "before" number.
    AOI_RADIUS: (() => {
        const fromEnv = Number.parseInt(process.env.TIBIA_AOI_RADIUS, 10);
        return Number.isFinite(fromEnv) ? fromEnv : 1000;
    })(),

    // Area of interest for the mob roster (roadmap 7.2, mobs).
    //
    // OFF BY DEFAULT, and that is a safety gate rather than an oversight.
    //
    // Removing a mob that has left the radius needs a client-side handler, because
    // the existing way to drop a mob out of the client's cache is
    // `mob_update` with `alive: false` -- which the client also uses for a death,
    // and which now spawns a blood-burst particle effect. Walking out of range
    // would spray blood at the player every time they turned around.
    //
    // So mob removal needs its own packet, and that packet needs a line in
    // client/js/engine.js. Until that line is in place, turning this on would
    // leave every client accumulating a frozen ghost of every mob it has ever
    // passed. Defaulting to 0 means this whole code path is inert, so the server
    // half can be committed and reviewed without putting the game at risk.
    //
    // Set it to 1000 to match AOI_RADIUS. The mob side needs its own knob because
    // the two features can be rolled back independently -- a mob that is visible but
    // not attackable is a very different bug from a player who is visible but not
    // attackable, and one of them may want reverting without the other.
    //
    // SAFETY INVARIANT, asserted by tests/unit/mob_aoi.test.js: this radius must
    // stay above AGGRO_RANGE (400) and the boss aggro range (600). Below either,
    // a mob can start hitting a player who cannot see it, which reads as being
    // attacked by an invisible monster and is worse than the bandwidth this saves.
    MOB_AOI_RADIUS: (() => {
        const fromEnv = Number.parseInt(process.env.TIBIA_MOB_AOI_RADIUS, 10);
        return Number.isFinite(fromEnv) ? fromEnv : 0;
    })(),
};
