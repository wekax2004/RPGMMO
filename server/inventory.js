/*
 * server/inventory.js
 *
 * Inventory, equipment and ground-item handlers, extracted from the server.js
 * monolith (roadmap 7.1 item 4).
 *
 * SIX ACTIONS: drop_item, pickup_item, use_item, equip_item, unequip_item,
 * toggle_mount.
 *
 * WHY MOUNTING IS IN HERE
 *
 * toggle_mount is not an inventory action. It is here because it is the only other
 * handler that changes what the player is carrying, and because its two helpers
 * (`mountPlayer`, `dismountPlayer`) broadcast to every client -- so the code that
 * changes the stance and the code that tells everyone about it belong together.
 *
 * Two things about it that are easy to get wrong, both confirmed by
 * tests/bots/inventory_probe.js rather than by reading:
 *
 *   - `mountPlayer` has NO inventory precondition. It returns false only when the
 *     player is already mounted. Any player may mount, with or without a mount
 *     item, because there is no mount item in the catalogue to check against. An
 *     earlier version of this file's comment claimed a precondition that does not
 *     exist, which is the kind of comment that sends the next reader looking for
 *     code that was never written.
 *   - `dismountPlayer` already broadcasts `mount_changed`, and this handler
 *     broadcasts it again. Every dismount therefore sends the packet twice. Left
 *     as-is: it is wasteful rather than wrong, and a refactor that quietly changes
 *     the packet count is not a refactor. Recorded in ROADMAP.md instead.
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT
 *
 * Inventory entries are bare strings, and the same string can appear more than
 * once. `indexOf` returns the *first* match, and every mutation here removes
 * exactly one instance via `splice(index, 1)`. Both matter:
 *
 *   - Using `splice(index)` or `filter` would destroy every copy.
 *   - Equipping takes one copy out of the bag and pushes the previously equipped
 *     item back in, so the count is conserved either way. A version that did
 *     `inventory = inventory.filter(...)` would silently delete the second copy
 *     of a stack, and the player would only notice when the item vanished.
 *
 * Nothing here trusts the client about what the player owns or where they are.
 * Both are re-derived: the item name is looked up in `player.inventory`, and the
 * pickup distance is computed server-side. A packet is cheap to forge.
 *
 * Context is passed in, not imported, for the reason given in social.js.
 */

/**
 * @param {object} ctx
 * @returns {boolean} true if the action belonged to inventory handling and has
 *   been handled. Every case returns rather than falling through, so an action
 *   this module claims cannot continue on to a later branch matching the same
 *   string.
 */
function handleInventory(ctx) {
    const {
        data, player,
        CFG, MAP, ITEMS,
        groundItems, nextGroundItemId,
        sendTo, sendProtocolError, broadcast, broadcastToFloor,
        dist3D, resolveGroundTarget, broadcastGroundSync,
        sendPlayerStatus, recalcPlayerStats, mountPlayer, dismountPlayer,
        now
    } = ctx;

    switch (data.action) {
        // --- ground ---------------------------------------------------------
        case 'drop_item': {
            // Accept either field name so the client can use whichever control it
            // already has.
            const raw = typeof data.item === 'string' ? data.item
                : (typeof data.itemName === 'string' ? data.itemName : '');
            const item = raw.slice(0, 100);
            if (!item) {
                sendProtocolError(player, 'No item specified.');
                return true;
            }
            const index = player.inventory.indexOf(item);
            if (index === -1) {
                sendProtocolError(player, 'You do not own that item.');
                return true;
            }
            if (groundItems.size >= CFG.GROUND_MAX_ITEMS) {
                sendProtocolError(player, 'The ground is too littered to drop more.');
                return true;
            }
            // Exactly one instance leaves the inventory, and the drop lands on the
            // tile the server believes the player occupies -- not the one the client
            // asked for.
            player.inventory.splice(index, 1);
            const id = nextGroundItemId();
            // The drop records the floor it was made on. Without it the entry had no
            // z at all, and both ends of that were wrong in opposite directions: a
            // dungeon player could never pick up their own drop, because dist3D
            // compared z = -1 against a missing value that normalised to the surface
            // and returned Infinity, while a surface player at the same X/Y could
            // take a dungeon item through the rock.
            groundItems.set(id, {
                id,
                name: item,
                x: player.x,
                y: player.y,
                z: MAP.normalizeZ(player.z),
                ownerId: player.id,
                droppedAt: now,
                expiresAt: now + CFG.GROUND_ITEM_TTL_MS
            });
            player.persistenceDirty = true;
            broadcastGroundSync();
            broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y, text: `-${item}`, color: '#cccccc' });
            sendPlayerStatus(player);
            return true;
        }

        case 'pickup_item': {
            const entry = resolveGroundTarget(player, data);
            if (!entry) {
                sendProtocolError(player, 'There is nothing to pick up there.');
                return true;
            }
            // Server-side distance check. Cheap to forge a packet without it, so it
            // is never inferred from the request.
            if (dist3D(player.x, player.y, player.z, entry.x, entry.y, entry.z) > CFG.GROUND_PICKUP_RANGE) {
                sendProtocolError(player, 'Too far away.');
                return true;
            }
            groundItems.delete(entry.id);
            player.inventory.push(entry.name);
            player.persistenceDirty = true;
            broadcastGroundSync();
            broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y, text: `+${entry.name}`, color: '#88ff88' });
            sendPlayerStatus(player);
            return true;
        }

        // --- consumables ----------------------------------------------------
        case 'use_item': {
            const itemIndex = player.inventory.indexOf(data.item);
            if (itemIndex === -1) return true;
            const itemDef = ITEMS.consumables[data.item];
            // An item that is not a consumable is left alone rather than consumed.
            // The alternative -- remove it and do nothing -- destroys a piece of
            // equipment the moment a client sends the wrong action for it.
            if (!itemDef) return true;
            player.inventory.splice(itemIndex, 1);
            if (itemDef.type === 'heal') {
                player.hp = Math.min(player.maxHp, player.hp + itemDef.val);
                broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y, text: `+${itemDef.val} HP`, color: '#44ff44' });
            }
            if (itemDef.type === 'mana') {
                player.mana = Math.min(player.maxMana, player.mana + itemDef.val);
                broadcastToFloor(player.z, { action: 'fct', x: player.x + 16, y: player.y, text: `+${itemDef.val} MP`, color: '#4488ff' });
            }
            return true;
        }

        // --- equipment ------------------------------------------------------
        case 'equip_item': {
            const itemIndex = player.inventory.indexOf(data.item);
            if (itemIndex === -1) return true;
            // Resolved by looking the name up in each catalogue rather than by a
            // client-supplied slot, so a client cannot put a sword in the boots slot
            // and have it be believed.
            let type = null;
            if (ITEMS.weapons && ITEMS.weapons[data.item]) type = 'weapon';
            else if (ITEMS.armor && ITEMS.armor[data.item]) type = 'armor';
            else if (ITEMS.helmets && ITEMS.helmets[data.item]) type = 'helmet';
            else if (ITEMS.legs && ITEMS.legs[data.item]) type = 'legs';
            else if (ITEMS.boots && ITEMS.boots[data.item]) type = 'boots';
            else if (ITEMS.shields && ITEMS.shields[data.item]) type = 'shield';
            else if (ITEMS.amulets && ITEMS.amulets[data.item]) type = 'amulet';
            // Not in any catalogue: left in the bag, silently. A client that offers
            // a "use" on an equippable should not lose the item.
            if (!type) return true;
            player.inventory.splice(itemIndex, 1);
            // The old occupant goes back to the bag. Count-conserved: one copy out,
            // one copy in, and the new item is not duplicated when the slot was empty.
            if (player.equipment[type]) player.inventory.push(player.equipment[type]);
            player.equipment[type] = data.item;
            sendTo(player, { action: 'log', message: `✨ Equipped ${data.item}` });
            recalcPlayerStats(player);
                        // No sendPlayerStatus here, and that is not an oversight. An earlier
            // version of this extraction added one, on the reasonable theory that an
            // inventory change should push the inventory. Measuring the packet count
            // showed it added a whole status packet per equip -- and one is already
            // pushed roughly every 300ms, so the extra send bought nothing and only
            // cost bandwidth. See tests/bots/equip_status_count.js.
            return true;
            return true;
        }

        case 'unequip_item': {
            const slot = data.slot;
            const validSlots = new Set(['weapon', 'shield', 'helmet', 'armor', 'legs', 'boots', 'amulet']);
            if (!validSlots.has(slot)) {
                sendProtocolError(player, 'Invalid equipment slot.');
                return true;
            }
            if (!player.equipment[slot]) return true;
            player.inventory.push(player.equipment[slot]);
            player.equipment[slot] = null;
            recalcPlayerStats(player);
                        // No sendPlayerStatus here, and that is not an oversight. An earlier
            // version of this extraction added one, on the reasonable theory that an
            // inventory change should push the inventory. Measuring the packet count
            // showed it added a whole status packet per equip -- and one is already
            // pushed roughly every 300ms, so the extra send bought nothing and only
            // cost bandwidth. See tests/bots/equip_status_count.js.
            return true;
            return true;
        }

        // --- mount ----------------------------------------------------------
        case 'toggle_mount': {
            // Checked against `now` rather than Date.now(), because the packet
            // handler already computed it once and a second call could land on the
            // other side of the stun expiry.
            if (player.stunUntil > now) {
                sendProtocolError(player, 'You cannot mount while stunned.');
                return true;
            }
            const mounting = !player.isMounted;
            if (mounting) {
                // mountPlayer returns false only when the player is already mounted,
                // which the `mounting` flag above has already excluded. So this
                // branch is unreachable in practice and is kept only because dropping
                // the return would change what happens if that ever stopped being
                // true -- mounting has to be able to fail without broadcasting.
                if (!mountPlayer(player)) return true;
            } else {
                // dismountPlayer broadcasts mount_changed itself, and so does the
                // broadcast below. Two packets per dismount. See the file header.
                dismountPlayer(player);
            }
            // Broadcast to everyone, not just the player: the mount changes the
            // sprite every other client draws, and a bystander seeing a mounted
            // player with no sprite is worse than a wasted packet.
            broadcast({
                action: 'mount_changed',
                id: player.id,
                isMounted: player.isMounted
            });
            sendTo(player, {
                action: 'status',
                isMounted: player.isMounted
            });
            sendTo(player, {
                action: 'log',
                message: player.isMounted
                    ? '🐴 You mount up and gain speed.'
                    : '🐴 You dismount.'
            });
            return true;
        }

        default:
            return false;
    }
}

/**
 * Every action this module claims.
 */
const INVENTORY_ACTIONS = new Set([
    'drop_item',
    'pickup_item',
    'use_item',
    'equip_item',
    'unequip_item',
    'toggle_mount'
]);

module.exports = { handleInventory, INVENTORY_ACTIONS };