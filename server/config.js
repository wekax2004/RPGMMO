const parsedPort = Number.parseInt(process.env.PORT, 10);

module.exports = {
    PORT: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 8080,
    HOST: process.env.HOST || '127.0.0.1',
    
    // גבולות מפה (בפיקסלים) - עולם פתוח גדול
    MAP_WIDTH: 3200,
    MAP_HEIGHT: 3200,
    TILE_SIZE: 32,
    
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
    MANA_REGEN_PER_SEC: 5,
    SAFEZONE_HEAL_PER_SEC: 5, // ריפוי אוטומטי בעיר

    // חפצים
    MAX_CHESTS: 30,
    CHEST_SPAWN_INTERVAL: 10000,
    CHEST_GOLD_REWARD: 50,
    
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
};
