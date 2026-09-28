'use strict';

/**
 * Combat and spell resolution.
 *
 * Extracted from the server.js game loop. Everything here mutates shared
 * world state, so the server hands in its live Maps and the callbacks that
 * own side effects (broadcast, XP, death checks, persistence) rather than
 * this module reaching back into the server. That keeps the dependency
 * direction one-way: server -> combat, never the reverse.
 */

const CFG = require('./config');
const ITEMS = require('./items');
const Q = require('./quests');
const PARTY = require('./party');
const SC = require('./subclasses');
const SKILLS = require('./skills');
const { bosses, spawnBoss } = require('./bosses');

/**
 * @param {object} deps
 * @param {Map} deps.players          live players map
 * @param {Map} deps.mobs             live mobs map
 * @param {() => boolean} deps.isDay  day/night flag getter (it is mutable)
 * @param {Function} deps.dist        manhattan distance
 * @param {Function} deps.inSafeZone
 * @param {Function} deps.broadcast
 * @param {Function} deps.sendTo
 * @param {Function} deps.addXp
 * @param {Function} deps.checkPlayerDeath
 * @param {Function} deps.sendQuestJournal
 * @param {Function} deps.spawnMobPack
 * @param {Function} deps.persistPlayer
 * @param {Function} deps.grantWhiteSkull   mark the aggressor (PvP)
 * @param {Function} deps.hasActiveSkull     is a player currently flagged
 * @param {Function} [deps.sendPlayerStatus]  push a full status packet
 * @param {Function} [deps.sendProtocolError] report a refused request
 */
function createCombat(deps) {
    const {
        players,
        mobs,
        isDay,
        dist,
        // Floor-aware distance: Infinity across a floor boundary, so every
        // `<= range` guard below rejects a cross-floor target on its own. `dist`
        // is kept for the handful of purely spatial checks that genuinely do
        // not care which floor something is on.
        dist3D,
        // Floor-scoped broadcast. A floating "+30 XP" over a corpse in the
        // dungeon means nothing to a player on the surface, who sees the text
        // at coordinates that do not exist in their world.
        broadcastToFloor,
        inSafeZone,
        broadcast,
        sendTo,
        addXp,
        checkPlayerDeath,
        sendQuestJournal,
        spawnMobPack,
        persistPlayer,
        awardSkill,
        grantWhiteSkull,
        hasActiveSkull,
        sendPlayerStatus,
        sendProtocolError
    } = deps;

    // --- Stat math -------------------------------------------------------

    function getSubclassModifiers(player) {
        if (!player || !player.subclass) return {};
        const data = SC.getSubclassData(player.subclass);
        return data && data.statModifiers ? data.statModifiers : {};
    }

    function applyCombatModifiers(player, baseAmount, type = 'generic') {
        const modifiers = getSubclassModifiers(player);
        let multiplier = Number(modifiers.damageMulti) || 1;
        if (type === 'fire') multiplier *= Number(modifiers.fireDamageMulti) || 1;
        if (type === 'heal') multiplier *= Number(modifiers.healMulti) || 1;
        if (player && player.maxHp > 0 && player.hp / player.maxHp < 0.3) {
            multiplier *= Number(modifiers.lowHpDamageMulti) || 1;
        }
        return Math.max(1, Math.floor(baseAmount * multiplier));
    }

    function getAttackRange(player, baseRange) {
        const modifiers = getSubclassModifiers(player);
        return Math.floor(baseRange * (Number(modifiers.rangeMulti) || 1));
    }

    function getAttackCooldown(player, baseCooldown) {
        const modifiers = getSubclassModifiers(player);
        return Math.max(100, Math.floor(baseCooldown / (Number(modifiers.attackSpeedMulti) || 1)));
    }

    function applyLifesteal(player, damage) {
        const lifesteal = Number(getSubclassModifiers(player).lifesteal) || 0;
        if (lifesteal > 0) player.hp = Math.min(player.maxHp, player.hp + Math.floor(damage * lifesteal));
    }

    // --- Death and rewards ----------------------------------------------

    function killMob(player, target) {
        // Multiple attackers can observe the same lethal hit in one tick. Only
        // the first observer is allowed to grant rewards or update the world.
        if (!mobs.has(target.id) || target.hp > 0) return;
        player.gold += CFG.MOB_KILL_GOLD;
        const partyShares = PARTY.shareXp(PARTY.getParty(player.id), target.xpReward, player, players);
        const xpRecipients = partyShares.length > 0
            ? partyShares
            : [{ member: player, xp: target.xpReward }];
        const mobName = target.name.replace('Elite ', '');
        xpRecipients.forEach(({ member, xp }) => {
            addXp(member, xp);
            const updates = Q.onMobKilled(member.quests, mobName);
            if (updates.length > 0) {
                updates.forEach(update => sendTo(member, { action: 'log', message: `📜 [QUEST] ${update.questName}: ${update.objective}` }));
                sendQuestJournal(member);
            }
        });
        broadcastToFloor(target.z, { action: 'fct', x: target.x+16, y: target.y, text: `+${target.xpReward} XP`, color: '#ffcc00' });

        let lootDropped = false;
        const loot = ITEMS.lootTable[target.type];
        if (loot) {
            loot.forEach(item => {
                let chance = item.chance;
                if (!isDay()) chance *= 1.5;
                if (Math.random() < chance) {
                    player.inventory.push(item.name);
                    lootDropped = true;
                    broadcastToFloor(target.z, { action: 'fct', x: target.x+16, y: target.y-20, text: `+${item.name}`, color: '#ffffff' });
                }
            });
        }

        if (lootDropped) {
            sendTo(player, { action: 'inventory_update', inventory: player.inventory, gold: player.gold });
            player.persistenceDirty = true;
        }

        mobs.delete(target.id);
        broadcast({ action: 'mob_update', id: target.id, alive: false });
        if (player.targetId === target.id) player.targetId = null;

        setTimeout(() => spawnMobPack(broadcast, Math.floor(Math.random() * 2) + 1), 5000);
    }

    // Skill training hooks. These are deliberately additive: each one is a
    // single call that reports the award upward, and none of them change how
    // damage is resolved. awardSkill is optional so combat stays usable in
    // isolation (for example from a future test harness).
    function trainMelee(player) {
        if (typeof awardSkill === 'function') awardSkill(player, 'sword', SKILLS.COMBAT_XP.meleeHit);
    }

    function trainSpell(player) {
        if (typeof awardSkill === 'function') awardSkill(player, 'magic', SKILLS.COMBAT_XP.spellCast);
    }

    function trainBossMelee(player) {
        if (typeof awardSkill === 'function') awardSkill(player, 'sword', SKILLS.COMBAT_XP.bossHit);
    }

    // --- Spell damage helper --------------------------------------------

    // Damages one mob and resolves the kill. Bound to the casting player so
    // every reward (gold, loot, XP) goes to them.
    function hitMobFor(player) {
        return function hitMob(m, dmg) {
            m.hp -= dmg;
            broadcastToFloor(m.z, { action: 'fct', x: m.x+16, y: m.y, text: `-${dmg}`, color: '#ff8866' });
            broadcast({ action: 'mob_update', id: m.id, type: m.type, name: m.name, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp, alive: true, isElite: m.isElite });
            if (m.hp <= 0) killMob(player, m);
        };
    }

    // --- Epic area spells -----------------------------------------------

    // A player counts as a hostile target under exactly the same rules the
    // auto-attack path uses: both in warmode, neither inside the safe zone.
    // Reusing that predicate keeps AoE from becoming a safe-zone bypass or a
    // griefing tool that bypasses warmode.
    function isHostileTo(caster, target) {
        if (!target || target.id === caster.id) return false;
        if (!(caster.warmode && target.warmode)) return false;
        return !inSafeZone(caster.x, caster.y, caster.z) && !inSafeZone(target.x, target.y, target.z);
    }

    // Applies the PvP consequence of hitting another player, so a Meteor
    // Strike follows the same skull rule as a sword swing.
    function punishPvP(caster, target) {
        if (typeof grantWhiteSkull !== 'function' || typeof hasActiveSkull !== 'function') return;
        if (hasActiveSkull(target)) return;
        if (!grantWhiteSkull(caster)) return;
        sendTo(caster, { action: 'log', message: '💀 You are now skulled! You will drop all your gold if you die.' });
        sendTo(target, { action: 'log', message: `💀 You were hit by ${caster.charName}.` });
        broadcastToFloor(caster.z, { action: 'fct', x: caster.x + 16, y: caster.y - 24, text: 'SKULL', color: '#ff4444' });
    }

    // Damages every mob in range and returns how many were hit, so the caller
    // can refuse to waste the cast on an empty field.
    function damageMobsInRadius(caster, hitMob, cx, cy, radius, damage) {
        let hit = 0;
        for (const m of mobs.values()) {
            if (m.hp <= 0) continue;
            if (Math.hypot(m.x - cx, m.y - cy) > radius) continue;
            hitMob(m, damage);
            hit++;
        }
        return hit;
    }

    // Shared entry point for the epic spells. Kept separate from castSpell's
    // cheap-spell economy (20 mana / 1s) so a balance change to one can never
    // silently alter the other, and so a failure here cannot consume the
    // cheap spell's cooldown.
    function castEpic(player, effect) {
        const now = Date.now();
        if (now - (player.lastEpicSpellTime || 0) < CFG.EPIC_SPELL_COOLDOWN_MS) {
            const wait = Math.ceil((CFG.EPIC_SPELL_COOLDOWN_MS - (now - (player.lastEpicSpellTime || 0))) / 1000);
            sendTo(player, { action: 'fct', x: player.x, y: player.y, text: `${wait}s`, color: '#888' });
            return null;
        }
        if (player.mana < CFG.EPIC_SPELL_MANA_COST) {
            sendTo(player, { action: 'fct', x: player.x, y: player.y, text: 'OOM', color: '#888' });
            return null;
        }
        player.mana -= CFG.EPIC_SPELL_MANA_COST;
        player.lastEpicSpellTime = now;
        trainSpell(player);
        const result = effect(player);
        if (typeof sendPlayerStatus === 'function') sendPlayerStatus(player);
        if (typeof persistPlayer === 'function') persistPlayer(player);
        return result;
    }

    // Meteor Strike: heavy AoE centred on the caster, hitting mobs and any
    // hostile player. Radius and damage come from config, never the client.
    function castMeteorStrike(player) {
        const radius = CFG.METEOR_STRIKE_RADIUS;
        const damage = CFG.METEOR_STRIKE_DAMAGE + player.level * 4;
        // Broadcast first so the client can start the screen shake while the
        // damage resolves, and include the radius so particle scale can match.
        broadcast({
            action: 'spell_anim', type: 'meteor_strike',
            x: player.x, y: player.y, radius, casterId: player.id
        });
        const hitMob = hitMobFor(player);
        const mobsHit = damageMobsInRadius(player, hitMob, player.x, player.y, radius, damage);
        let playersHit = 0;
        for (const target of players.values()) {
            if (target.hp <= 0) continue;
            if (Math.hypot(target.x - player.x, target.y - player.y) > radius) continue;
            if (!isHostileTo(player, target)) continue;
            const dealt = damage + Math.floor(player.level * 2);
            target.hp -= dealt;
            broadcastToFloor(target.z, { action: 'fct', x: target.x + 16, y: target.y, text: `-${dealt}`, color: '#ff8800' });
            checkPlayerDeath(target, player.charName);
            punishPvP(player, target);
            playersHit++;
        }
        return { mobsHit, playersHit };
    }

    // Holy Nova: heals allies in range and damages everything hostile. An
    // ally is anyone who is not a valid PvP target, so the two halves of the
    // spell can never both apply to the same target.
    function castHolyNova(player) {
        const radius = CFG.HOLY_NOVA_RADIUS;
        const healAmount = CFG.HOLY_NOVA_HEAL + player.level * 3;
        const damage = CFG.HOLY_NOVA_DAMAGE + player.level * 2;
        broadcast({
            action: 'spell_anim', type: 'holy_nova',
            x: player.x, y: player.y, radius, casterId: player.id
        });
        const hitMob = hitMobFor(player);
        const mobsHit = damageMobsInRadius(player, hitMob, player.x, player.y, radius, damage);

        let healed = 0, playersHit = 0;
        for (const target of players.values()) {
            if (target.hp <= 0) continue;
            if (Math.hypot(target.x - player.x, target.y - player.y) > radius) continue;
            if (isHostileTo(player, target)) {
                target.hp -= damage;
                broadcastToFloor(target.z, { action: 'fct', x: target.x + 16, y: target.y, text: `-${damage}`, color: '#ff8800' });
                checkPlayerDeath(target, player.charName);
                punishPvP(player, target);
                playersHit++;
            } else if (target.hp < target.maxHp) {
                target.hp = Math.min(target.maxHp, target.hp + healAmount);
                broadcastToFloor(target.z, { action: 'fct', x: target.x + 16, y: target.y, text: `+${healAmount}`, color: '#44ff44' });
                sendTo(target, { action: 'log', message: `✝ Holy Nova restored ${healAmount} HP.` });
                healed++;
            }
        }
        // Keep the caster's own bar honest even when already at full health.
        sendPlayerStatus(player);
        return { healed, playersHit, mobsHit };
    }

    // --- Class spells ----------------------------------------------------

    // Warrior: Cleave / Charge. Mage: Fireball / Frost Nova.
    // Ranger: Multishot / Trap. Healer: Flash Heal / Holy Smite.
    function castSpell(player, spellId) {
        const now = Date.now();

        // Epic spells (index 3) run on their own cost and cooldown and are
        // resolved before the cheap-spell path. Index 3 is used deliberately:
        // the client already binds keys "1" and "2", so this leaves both
        // existing buttons byte-for-byte unchanged.
        if (Number(spellId) === 3) {
            if (player.classType === 'mage') return castEpic(player, castMeteorStrike);
            if (player.classType === 'healer') return castEpic(player, castHolyNova);
            sendProtocolError(player, 'Your class has no epic spell.');
            return null;
        }

        if (now - (player.lastSpellTime || 0) < 1000) return; // 1 second cooldown
        
        const cost = 20;
        if (player.mana < cost) {
            sendTo(player, { action: 'fct', x: player.x, y: player.y, text: 'OOM', color: '#888' });
            return;
        }
        player.mana -= cost;
        player.lastSpellTime = now;

        // Magic XP is earned by the spell RESOLVING, not by pressing the
        // button. Awarding on every cast let a player stand still in the safe
        // zone and cast on a timer forever: mana regen funds one cast every
        // four seconds, so it measured a flat ~2 XP/sec with no enemy, no
        // movement and no risk. The 1s cooldown did not help because mana, not
        // the cooldown, was the binding limit. The award now happens below,
        // only if the spell actually hit something or healed someone.
        let spellDidSomething = false;

        const baseHitMob = hitMobFor(player);
        // Wrapped so we can tell whether the spell connected with anything.
        const hitMob = (m, dmg) => {
            spellDidSomething = true;
            return baseHitMob(m, dmg);
        };
        const c = player.classType;

        if (c === 'warrior') {
            if (spellId === 1) { // Cleave
                broadcast({ action: 'spell_anim', type: 'cleave', x: player.x, y: player.y });
                for (let [mid, m] of mobs) {
                    if (dist3D(player.x, player.y, player.z, m.x, m.y, m.z) <= 60) hitMob(m, 50 + player.level * 2);
                }
            } else { // Charge
                if (player.targetId && mobs.has(player.targetId)) {
                    const t = mobs.get(player.targetId);
                    player.x = t.x; player.y = t.y + 32;
                    sendTo(player, { action: 'force_position', x: player.x, y: player.y });
                    broadcast({ action: 'spell_anim', type: 'charge', x: player.x, y: player.y });
                    hitMob(t, 60 + player.level * 3);
                }
            }
        } else if (c === 'mage') {
            if (spellId === 1) { // Fireball
                if (player.targetId && mobs.has(player.targetId)) {
                    const t = mobs.get(player.targetId);
                    broadcast({ action: 'spell_anim', type: 'fireball', x: t.x, y: t.y });
                    for (let [mid, m] of mobs) {
                        if (dist3D(t.x, t.y, t.z, m.x, m.y, m.z) <= 80) hitMob(m, 60 + player.level * 3);
                    }
                }
            } else { // Frost Nova
                broadcast({ action: 'spell_anim', type: 'frostnova', x: player.x, y: player.y });
                for (let [mid, m] of mobs) {
                    if (dist3D(player.x, player.y, player.z, m.x, m.y, m.z) <= 100) hitMob(m, 30 + player.level);
                }
            }
        } else if (c === 'ranger') {
            if (spellId === 1) { // Multishot
                broadcast({ action: 'spell_anim', type: 'multishot', x: player.x, y: player.y });
                let hits = 0;
                for (let [mid, m] of mobs) {
                    if (dist3D(player.x, player.y, player.z, m.x, m.y, m.z) <= 200 && hits < 3) {
                        hitMob(m, 40 + player.level * 2);
                        hits++;
                    }
                }
            } else { // Trap (Instant damage for now)
                if (player.targetId && mobs.has(player.targetId)) {
                    const t = mobs.get(player.targetId);
                    broadcast({ action: 'spell_anim', type: 'trap', x: t.x, y: t.y });
                    hitMob(t, 80 + player.level * 4);
                }
            }
        } else if (c === 'healer') {
            if (spellId === 1) { // Flash Heal
                // Only a heal that actually restored health trains magic, so
                // casting at full health is not a free XP generator.
                const before = player.hp;
                player.hp = Math.min(player.maxHp, player.hp + 50 + player.level * 5);
                if (player.hp > before) {
                    spellDidSomething = true;
                    broadcastToFloor(player.z, { action: 'fct', x: player.x, y: player.y, text: `+${player.hp - before}`, color: '#44ff44' });
                }
                broadcast({ action: 'spell_anim', type: 'heal', x: player.x, y: player.y });
            } else { // Holy Smite
                if (player.targetId && mobs.has(player.targetId)) {
                    const t = mobs.get(player.targetId);
                    broadcast({ action: 'spell_anim', type: 'smite', x: t.x, y: t.y });
                    hitMob(t, 50 + player.level * 2);
                }
            }
        }

        // The mana is spent either way, but the skill only grows when the
        // spell actually did something. A whiff costs mana and teaches nothing.
        if (spellDidSomething) trainSpell(player);
    }

    // --- Game loop: player auto-attacks ----------------------------------

    // Resolves a player's current target: another player (PvP) or a mob.
    function runAutoAttack(now) {
        players.forEach((player, playerId) => {
            if (player.targetId) {
                if (players.has(player.targetId)) {
                    const target = players.get(player.targetId);
                    if (player.warmode && target.warmode && !inSafeZone(player.x, player.y, player.z) && !inSafeZone(target.x, target.y, target.z)) {
                        // PvP is same-floor. dist3D returns Infinity across a
                        // boundary, so a warmode duel cannot be carried out
                        // against someone a floor away.
                        const d = dist3D(player.x, player.y, player.z, target.x, target.y, target.z);
                        const range = getAttackRange(player, (player.classType === 'mage' || player.classType === 'ranger') ? CFG.RANGED_RANGE : CFG.MELEE_RANGE);
                        if (d <= range && now - player.lastAttackTime >= getAttackCooldown(player, CFG.PLAYER_ATTACK_COOLDOWN)) {
                            player.lastAttackTime = now;
                            let damage = applyCombatModifiers(player, Math.floor(Math.random() * 15) + 5 + (player.level * 2));
                            if (player.equipment.weapon && ITEMS.weapons[player.equipment.weapon]) {
                                damage += ITEMS.weapons[player.equipment.weapon].bonus;
                            }
                            target.hp -= damage; applyLifesteal(player, damage);
                            broadcast({ action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: target.x, ty: target.y });
                            broadcastToFloor(target.z, { action: 'fct', x: target.x+16, y: target.y, text: `-${damage}`, color: '#ff8800' });
                            checkPlayerDeath(target, player.charName);
                            if (player.classType === 'warrior') trainMelee(player);
                            // Attacking someone who is not already flagged
                            // marks the aggressor, so a single gank is not a
                            // permanent state and going skulled is costly.
                            if (typeof grantWhiteSkull === 'function' && typeof hasActiveSkull === 'function' && !hasActiveSkull(target)) {
                                if (grantWhiteSkull(player)) {
                                    sendTo(player, { action: 'log', message: '💀 You are now skulled! You will drop all your gold if you die.' });
                                    sendTo(target, { action: 'log', message: '💀 You were attacked by ' + player.charName + '.' });
                                    broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y - 24, text: 'SKULL', color: '#ff4444' });
                                }
                            }
                        }
                    }
                }
                else if (mobs.has(player.targetId)) {
                    const target = mobs.get(player.targetId);
                    const d = dist3D(player.x, player.y, player.z, target.x, target.y, target.z);
                    const range = getAttackRange(player, (player.classType === 'mage' || player.classType === 'ranger') ? CFG.RANGED_RANGE : CFG.MELEE_RANGE);
                    if (d <= range && now - player.lastAttackTime >= getAttackCooldown(player, CFG.PLAYER_ATTACK_COOLDOWN)) {
                        player.lastAttackTime = now;
                        let damage = applyCombatModifiers(player, Math.floor(Math.random() * 15) + 10 + (player.level * 2));

                        if (player.equipment.weapon && ITEMS.weapons[player.equipment.weapon]) {
                            damage += ITEMS.weapons[player.equipment.weapon].bonus;
                        }

                        target.hp -= damage; applyLifesteal(player, damage);
                        broadcast({ action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: target.x, ty: target.y });
                        broadcastToFloor(target.z, { action: 'fct', x: target.x+16, y: target.y, text: `-${damage}`, color: '#ffffff' });
                        broadcast({ action: 'mob_update', id: player.targetId, x: target.x, y: target.y, hp: target.hp, maxHp: target.maxHp, alive: true, isElite: target.isElite, name: target.name, type: target.type });
                        if (target.hp <= 0) killMob(player, target);
                        if (player.classType === 'warrior') trainMelee(player);
                    }
                }
            }
        });
    }

    // --- Game loop: player vs boss --------------------------------------

    function runBossAttacks(bossId, boss, now) {
        players.forEach(player => {
            if (player.targetId === bossId && boss.hp > 0 && bosses.has(bossId)) {
                const d = dist3D(player.x, player.y, player.z, boss.x, boss.y, boss.z);
                const range = getAttackRange(player, (player.classType === 'mage' || player.classType === 'ranger' || player.classType === 'healer') ? CFG.RANGED_RANGE : CFG.MELEE_RANGE);
                if (d <= range && now - player.lastAttackTime >= getAttackCooldown(player, CFG.PLAYER_ATTACK_COOLDOWN)) {
                    player.lastAttackTime = now;
                    let damage = applyCombatModifiers(player, Math.floor(Math.random() * 15) + 10 + (player.level * 2));
                    if (player.equipment.weapon && ITEMS.weapons[player.equipment.weapon]) damage += ITEMS.weapons[player.equipment.weapon].bonus;
                    boss.hp -= damage; applyLifesteal(player, damage);
                    broadcast({ action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: boss.x, ty: boss.y });
                    broadcastToFloor(boss.z, { action: 'fct', x: boss.x+16, y: boss.y, text: `-${damage}`, color: '#ffffff' });
                    if (player.classType === 'warrior') trainBossMelee(player);
                    broadcast({ action: 'mob_update', id: bossId, x: boss.x, y: boss.y, hp: boss.hp, maxHp: boss.maxHp, alive: true, isBoss: true, name: boss.name, type: boss.type });

                    if (boss.hp <= 0) {
                        // Boss killed!
                        broadcast({ action: 'log', message: `🏆 ${player.charName} has slain ${boss.name}!` });
                        broadcastToFloor(boss.z, { action: 'fct', x: boss.x, y: boss.y, text: '💀 BOSS SLAIN!', color: '#ff00ff' });

                        // Distribute loot
                        const loot = ITEMS.lootTable[boss.type];
                        if (loot) {
                            // Find all eligible players (the killer + party members in range)
                            const eligiblePlayers = [player];
                            const party = PARTY.getParty(player.id);
                            if (party) {
                                party.members.forEach(memberId => {
                                    if (memberId !== player.id) {
                                        const member = players.get(memberId);
                                        if (member && member.hp > 0 && Math.hypot(member.x - boss.x, member.y - boss.y) <= 800) {
                                            eligiblePlayers.push(member);
                                        }
                                    }
                                });
                            }

                            // Roll loot for each eligible player
                            eligiblePlayers.forEach(p => {
                                loot.forEach(item => {
                                    if (Math.random() < item.chance) {
                                        p.inventory.push(item.name);
                                        sendTo(p, { action: 'log', message: `You looted: ${item.name}` });
                                        if (p.id === player.id) { // Only show FCT for the actual killer
                                            broadcastToFloor(boss.z, { action: 'fct', x: boss.x+16, y: boss.y-20, text: `+${item.name}`, color: '#ff00ff' });
                                        }
                                    }
                                });
                                persistPlayer(p); // save inventory
                            });
                        }
                        addXp(player, boss.xpReward);
                        const bossQuestUpdates = Q.onMobKilled(player.quests, boss.name);
                        if (bossQuestUpdates.length > 0) {
                            bossQuestUpdates.forEach(update => sendTo(player, { action: 'log', message: `📜 [QUEST] ${update.questName}: ${update.objective}` }));
                            sendQuestJournal(player);
                        }
                        if (player.targetId === bossId) player.targetId = null;

                        bosses.delete(bossId);
                        broadcast({ action: 'mob_update', id: bossId, alive: false });

                        // Respawn boss after 60s
                        setTimeout(() => {
                            spawnBoss(boss.type, broadcast);
                        }, 60000);
                    }
                }
            }
        });
    }

    return {
        applyCombatModifiers,
        getAttackRange,
        getAttackCooldown,
        applyLifesteal,
        killMob,
        castSpell,
        runAutoAttack,
        runBossAttacks
    };
}

module.exports = { createCombat };
