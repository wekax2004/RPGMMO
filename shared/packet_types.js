/**
 * Shared Packet Types & Protocol Schema
 * This file contains constants for all WebSocket message action types
 * to ensure consistency between the client and server.
 */

const PACKET = {
    // Client -> Server (Requests)
    C2S: {
        AUTH_LOGIN: 'auth_login',
        AUTH_REGISTER: 'auth_register',
        AUTH_LOGOUT: 'auth_logout',
        LOGIN: 'login',           // Character select
        MOVE: 'move',
        ATTACK: 'attack',
        CAST_SPELL: 'cast_spell',
        CAST_SUBCLASS_SKILL: 'cast_subclass_skill',
        USE_ITEM: 'use_item',
        EQUIP_ITEM: 'equip',
        DROP_ITEM: 'drop_item',
        TALK_NPC: 'talk_npc',
        ACCEPT_QUEST: 'accept_quest',
        TURN_IN_QUEST: 'turn_in_quest',
        TRADE_REQUEST: 'trade_request',
        TRADE_RESPONSE: 'trade_response',
        TRADE_ADD_ITEM: 'trade_add_item',
        TRADE_LOCK: 'trade_lock',
        TRADE_CONFIRM: 'trade_confirm',
        TRADE_CANCEL: 'trade_cancel',
        PARTY_INVITE: 'party_invite',
        PARTY_ACCEPT: 'party_accept',
        PARTY_LEAVE: 'party_leave',
        CHAT: 'chat',
        PING: 'ping'
    },

    // Server -> Client (Responses / Broadcasts)
    S2C: {
        AUTH_REQUIRED: 'auth_required',
        AUTH_SUCCESS: 'auth_success',
        AUTH_ERROR: 'auth_error',
        AUTH_LOGOUT_SUCCESS: 'auth_logout_success',
        LOGIN_ERROR: 'login_error',
        SHOW_CLASS_SELECT: 'show_class_select',
        SHOW_SUBCLASS_SELECT: 'show_subclass_select',
        EVOLUTION_COMPLETE: 'evolution_complete',
        YOUR_ID: 'your_id',
        MAP_DATA: 'map_data',
        TIME_SYNC: 'time_sync',
        PLAYERS_SYNC: 'players_sync',
        MOB_UPDATE: 'mob_update',
        NPC_UPDATE: 'npc_update',
        CHEST_UPDATE: 'chest_update',
        INVENTORY_SYNC: 'inventory_sync',
        GOLD_SYNC: 'gold_sync',
        FCT: 'fct', // Floating Combat Text
        FORCE_POSITION: 'force_position',
        BOSS_AOE: 'boss_aoe',
        AOE_WARNING: 'aoe_warning',
        AOE_IMPACT: 'aoe_impact',
        TRADE_REQUESTED: 'trade_requested',
        TRADE_SYNC: 'trade_sync',
        TRADE_LOCKED: 'trade_locked',
        TRADE_SUCCESS: 'trade_success',
        TRADE_CANCELLED: 'trade_cancelled',
        PARTY_SYNC: 'party_sync',
        PARTY_INVITED: 'party_invited',
        CHAT_MESSAGE: 'chat_message',
        PONG: 'pong'
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = PACKET;
} else {
    window.PACKET = PACKET;
}
