        const canvas = document.getElementById("gameCanvas");
        const ctx = canvas.getContext("2d");
        const chatInput = document.getElementById("chat-input");

        const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(socketProtocol + "//" + window.location.host);

        let MAP_W = 3200, MAP_H = 3200;
        let MAP_BOUNDS = null;
        let SAFE_ZONE = {w: 800, h: 800};
        const SCREEN_W = 640, SCREEN_H = 480;

        let myId = null, myName = "Player";
        let player = { x: 320, y: 320, classType: "warrior", warmode: false };
        let myLevel = 1, speedBonus = 0;
        // Previous status values, used to detect level-ups and taking damage.
        let lastKnownLevel = 0, lastKnownHp = 0;
        
        let otherPlayers = {};
        let mobs = {};
        let chests = {};
        let clientCorpses = {};
        let gatherNodes = {};
        let groundItemsLocal = [];
        let floatingTextsLocal = [];
        let itemDict = { items: {}, materials: {}, recipes: {} };
        let floorTransitions = [];
        window.currentZ = 0;

        function getItemTooltip(name) {
            let tooltip = name + "\n";
            if (itemDict.materials && itemDict.materials[name]) {
                tooltip += "[Crafting Material] Tier " + itemDict.materials[name].tier + "\n";
            }
            if (itemDict.items) {
                for (let cat in itemDict.items) {
                    if (itemDict.items[cat][name]) {
                        let itm = itemDict.items[cat][name];
                        if (itm.type === 'weapon') tooltip += `Damage: +${itm.bonus}\n`;
                        if (itm.type === 'armor' || itm.type === 'helmet' || itm.type === 'legs' || itm.type === 'shield') tooltip += `Defense: +${itm.def}\n`;
                        if (itm.type === 'boots') tooltip += `Defense: +${itm.def} | Speed: +${itm.speedBonus}\n`;
                        if (itm.type === 'amulet') tooltip += `HP Bonus: +${itm.maxHpBonus}\n`;
                        if (itm.type === 'heal') tooltip += `Heals: ${itm.val} HP\n`;
                        if (itm.type === 'mana') tooltip += `Restores: ${itm.val} Mana\n`;
                        break;
                    }
                }
            }
            return tooltip.trim();
        }

        let npcsLocal = {};
        
        let obstacles = [];
        let obstacleSet = new Set();
        // Obstacle types that are drawn but still walkable. Must stay in sync
        // with the server's transition table in server/map.js -- if the server
        // places a tile type that is walkable and the client treats it as solid,
        // the traversal can be triggered but never reached.
        const WALKABLE_OBSTACLE_TYPES = new Set(["ladder", "stairs_up", "stairs_down"]);
        let fcts = [];
        let particles = [];
        let currentTargetId = null;
        let cameraX = 0, cameraY = 0;
        let isDay = true;
        
        let authToken = null;
        let myGold = 0;
        let myInventoryData = [];
        let bossAoeEffects = [];
        let activeSpells = [];

        let packetQueue = [];
        window.CLIENT_READY = false;

        socket.onmessage = (event) => {
            if (!window.CLIENT_READY) {
                packetQueue.push(event);
                return;
            }
            
            const data = JSON.parse(event.data);
            
            // The server reports a refused login under two names. login_error
            // covers a bad character name, an unknown class, a name already
            // online; login_fail covers a throttled connection. Handling only
            // the first meant a player who was simply logged into too many
            // times got no response at all -- the request vanished and the
            // client sat there looking like it had hung.
            if (data.action === "login_error" || data.action === "login_fail" || data.action === "auth_error") {
                if (data.action === "auth_error") {
                    document.getElementById("overlay").style.display = "block";
                    document.getElementById("auth-error").innerText = data.message || "Authentication failed.";
                    let a = document.getElementById("auth-modal"); a.style.display = "block"; a.classList.add("active");
                    return;
                }
                document.getElementById("overlay").style.display = "block";
                let b = document.getElementById("class-modal"); b.style.display = "block"; b.classList.add("active");
                addLog("❌ " + (data.message || "Unable to log in."));
            }
            else if (data.action === "auth_required") {
                document.getElementById("overlay").style.display = "block";
                document.getElementById("auth-modal").style.display = "block";
            }
            else if (data.action === "auth_success") {
                authToken = data.token;
                document.getElementById("auth-modal").style.display = "none";
                document.getElementById("class-modal").style.display = "block";
                if (data.account && data.account.username) {
                    document.getElementById("char-name").value = data.account.username;
                    document.getElementById("char-name").readOnly = true;
                }
            }
            else if (data.action === "show_class_select") {
                document.getElementById("overlay").style.display = "block";
                document.getElementById("class-modal").style.display = "block";
            }
            else if (data.action === "show_subclass_select") {
                document.getElementById("overlay").style.display = "block";
                let sub = document.getElementById("subclass-modal"); sub.style.display = "block"; sub.classList.add("active");
                const options = data.subclasses || data.options || [];
                let html = "";
                options.forEach(opt => {
                    const id = typeof opt === "string" ? opt : opt.id;
                    const name = typeof opt === "string" ? opt : opt.name;
                    const description = typeof opt === "string" ? "" : (opt.description || "");
                    html += "<div id='subclass-card-" + escapeHtml(id) + "' class='class-card subclass-card' onclick='selectSubclass(\"" + escapeHtml(id) + "\")'><h3 style='color:#00aaff; margin:0'>" + escapeHtml(name) + "</h3><p style='font-size:10px;color:#aaa'>" + escapeHtml(description) + "</p></div>";
                });
                document.getElementById("subclass-options").innerHTML = html;
            }
            else if (data.action === "evolution_complete") {
                document.getElementById("overlay").style.display = "none";
                document.getElementById("subclass-modal").style.display = "none";
            }
            else if (data.action === "boss_aoe" || data.action === "aoe_warning" || data.action === "aoe_impact") {
                handleBossAoe(data);
            }
            else if (data.action === "trade_requested") {
                pendingTradeRequest = {
                    requestId: data.requestId || data.tradeRequestId || null,
                    fromPlayer: data.fromPlayer || data.from || null,
                    fromName: data.fromName || data.from || "A player"
                };
                document.getElementById("overlay").style.display = "block";
                document.getElementById("trade-modal").style.display = "block";
                document.getElementById("trade-request-actions").style.display = "block";
                document.getElementById("trade-request-text").innerText = pendingTradeRequest.fromName + " requested a trade.";
                addLog("📨 Trade request received from " + pendingTradeRequest.fromName + ".");
            }
            else if (data.action === "trade_open") {
                activeTradeId = data.tradeId || (data.trade && data.trade.tradeId) || null;
                tradeLocked = false;
                pendingTradeRequest = null;
                document.getElementById("trade-lock-btn").disabled = false;
                document.getElementById("trade-confirm-btn").disabled = true;
                document.getElementById("trade-request-actions").style.display = "none";
                document.getElementById("overlay").style.display = "block";
                document.getElementById("trade-modal").style.display = "block";
                document.getElementById("trade-my-gold").value = 0;
                document.getElementById("trade-my-offer").innerHTML = "";
                document.getElementById("trade-their-offer").innerHTML = "";
                document.getElementById("trade-their-gold").innerText = "Gold: 0";
            }
            else if (data.action === "trade_update") {
                handleTradeSync(data);
            }
            else if (data.action === "trade_locked") {
                tradeLocked = true;
                handleTradeSync(data);
                addLog("🔒 Both players locked the trade. Confirm to complete it.");
            }
            else if (data.action === "trade_complete") {
                addLog("✅ Trade completed.");
            }
            else if (data.action === "trade_close") {
                activeTradeId = null;
                tradeLocked = false;
                pendingTradeRequest = null;
                document.getElementById("trade-request-actions").style.display = "none";
                document.getElementById("trade-lock-btn").disabled = false;
                document.getElementById("trade-confirm-btn").disabled = false;
                document.getElementById("overlay").style.display = "none";
                document.getElementById("trade-modal").style.display = "none";
            }
            else if (data.action === "guild_sync") {
                myGuild = data.guild;
                const gList = document.getElementById("guild-list");
                if (!myGuild) { gList.innerHTML = "<em style='color:#666'>No Guild</em>"; }
                else {
                    let h = "<b>" + escapeHtml(myGuild.name) + "</b><br/>Leader: " + escapeHtml(myGuild.leader) + "<br/>Members:<br/>";
                    myGuild.members.forEach(m => h += "- " + escapeHtml(m) + "<br/>");
                    gList.innerHTML = h;
                }
            }
            else if (data.action === "party_update" || data.action === "party_sync") {
                if (data.party !== null && data.members && data.members.length > 0) pendingPartyInvite = null;
                renderParty(data.party || data);
            }
            else if (data.action === "party_invited" || data.action === "party_invite") {
                pendingPartyInvite = { partyId: data.partyId || null, inviter: data.inviter || data.from || "A player" };
                addLog("📨 " + pendingPartyInvite.inviter + " invited you to a party.");
                renderParty({ members: [] });
            }
            else if (data.action === "guild_invited") {
                // The guild id is kept, not just the name, so the pending invite
                // can be confirmed against the guild it belongs to. A name is
                // ambiguous the moment two guilds share one.
                pendingGuildInvite = {
                    guildId: data.guildId,
                    guildName: data.guildName,
                    inviter: data.inviter || "A player"
                };
                addLog("🛡️ " + pendingGuildInvite.inviter + " invited you to " + data.guildName +
                    ". Type /guild accept to join.");
            }
            else if (data.action === "bank_open") {
                if (typeof openBank === 'function') openBank(data);
            }
            else if (data.action === "bank_update") {
                if (typeof renderBank === 'function') renderBank(data);
            }
            else if (data.action === "map_data") { 
                const newZ = data.z || 0;
                if (window.currentZ !== undefined && window.currentZ !== newZ) {
                    otherPlayers = {};
                    mobs = {};
                    clientCorpses = {};
                    groundItemsLocal = [];
                }
                window.currentZ = newZ;
                obstacles = data.obstacles; 
                // The traversal tiles arrive as their own list, keyed by where
                // they lead rather than by how they look. It was previously
                // discarded, which left the client unable to say anything about
                // its own exits -- a floor label and a drawing, with no way to
                // tell "nowhere to go" from "you have not looked yet".
                floorTransitions = data.transitions || [];
                MAP_BOUNDS = data.bounds || null;
                if (data.width) MAP_W = data.width;
                if (data.height) MAP_H = data.height;
                if (data.safeZone) SAFE_ZONE = data.safeZone;
                obstacleSet.clear();
                // Ladders and stairs are sent in `obstacles` because the terrain
                // renderer draws them from that same array, but they are walked
                // ONTO, not around -- standing on a ladder is what triggers the
                // descent. Feeding them into obstacleSet would make them block
                // movement exactly like a wall, so the player could never reach
                // one and the floor below would be unreachable.
                // WATER_TILE_TYPES stay blocked: water is a genuine obstacle and
                // fishing happens from an adjacent walkable tile.
                obstacles.forEach(o => {
                    if (WALKABLE_OBSTACLE_TYPES.has(o.type)) return;
                    obstacleSet.add(o.x + "," + o.y);
                });
            }
            else if (data.action === "time_sync") { isDay = data.isDay; }
            else if (data.action === "fct") {
                fcts.push({ text: data.text, x: data.x, y: data.y, color: data.color, life: 1.0, driftX: (Math.random() - 0.5) * 40 });
                // Floating combat text is how the server reports loot and XP.
                if (/^\+.*Gold$|^\+\d+G$/.test(data.text || "")) audio.loot();
                
                // Spawn blood particles on damage
                if (data.text.startsWith("-")) {
                    for (let i = 0; i < 6; i++) {
                        particles.push({
                            x: data.x + (Math.random() - 0.5) * 20,
                            y: data.y + (Math.random() - 0.5) * 20,
                            vx: (Math.random() - 0.5) * 4,
                            vy: (Math.random() - 0.5) * 4 - 2, // jump up
                            life: 1.0,
                            color: '#b91c1c' // Deep red blood
                        });
                    }
                }
            }
else if (data.action === "spell_anim") {
                let color = "rgba(255, 255, 255, 0.5)";
                let radius = 30;
                if (data.type === 'cleave') { color = "rgba(255, 50, 50, 0.6)"; radius = 60; }
                else if (data.type === 'charge') { color = "rgba(200, 200, 200, 0.8)"; radius = 40; }
                else if (data.type === 'fireball') { color = "rgba(255, 100, 0, 0.7)"; radius = 80; }
                else if (data.type === 'frostnova') { color = "rgba(100, 200, 255, 0.6)"; radius = 100; }
                else if (data.type === 'multishot') { color = "rgba(150, 255, 150, 0.6)"; radius = 50; }
                else if (data.type === 'trap') { color = "rgba(100, 100, 100, 0.8)"; radius = 40; }
                else if (data.type === 'heal') { color = "rgba(50, 255, 50, 0.6)"; radius = 40; }
                else if (data.type === 'smite') { color = "rgba(255, 255, 100, 0.8)"; radius = 40; }
                bossAoeEffects.push({ x: data.x, y: data.y, radius: radius, state: "detonate", type: data.type });
                setTimeout(() => { bossAoeEffects.pop(); }, 300);
                audio.spellBlast();
            }
            else if (data.action === "spell") {
                activeSpells.push({ startTime: Date.now(), sx: data.sx, sy: data.sy, tx: data.tx, ty: data.ty, type: data.type });
                audio.spellBlast();
            }
            else if (data.action === "spell_anim") {
                // Epic AoE Spell Visuals
                if (data.type === "meteor_strike") {
                    for(let i=0; i<80; i++) {
                        let angle = Math.random() * Math.PI * 2;
                        let speed = 2 + Math.random() * 6;
                        particles.push({ 
                            x: data.x + 16, y: data.y + 16, 
                            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, 
                            life: 1.0, maxLife: 1.0, gravity: 0,
                            color: Math.random() > 0.5 ? "#f97316" : "#dc2626", size: 4 
                        });
                    }
                    audio.spellBlast();
                }
                else if (data.type === "holy_nova") {
                    for(let i=0; i<80; i++) {
                        let angle = Math.random() * Math.PI * 2;
                        let speed = 2 + Math.random() * 6;
                        particles.push({ 
                            x: data.x + 16, y: data.y + 16, 
                            vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, 
                            life: 1.0, maxLife: 1.0, gravity: 0,
                            color: Math.random() > 0.5 ? "#fef08a" : "#fef9c3", size: 4 
                        });
                    }
                    audio.spellBlast();
                }
            }
            else if (data.action === "ground_sync") { groundItemsLocal = data.items; }
            else if (data.action === "your_id") { myId = data.id; myName = data.name; }
            else if (data.action === "force_position") { player.x = data.x; player.y = data.y; }
            else if (data.action === "mob_update") {
                if (data.alive) { 
                    if(!mobs[data.id]) mobs[data.id] = { x: data.x, y: data.y, id: data.id, hp: data.hp, maxHp: data.maxHp, isElite: data.isElite, isBoss: data.isBoss, name: data.name, type: data.type, phase: data.phase || 1, renderX: data.x, renderY: data.y, dir: 0, moveFrame: 0 }; 
                    else { 
                        let m = mobs[data.id];
                        if (data.x > m.x) m.dir = 2;
                        else if (data.x < m.x) m.dir = 1;
                        else if (data.y > m.y) m.dir = 0;
                        else if (data.y < m.y) m.dir = 3;
                        if (m.x !== data.x || m.y !== data.y) m.moveFrame = ((m.moveFrame || 0) + 1) % 3;
                        m.hp = data.hp; m.maxHp = data.maxHp; m.x = data.x; m.y = data.y; 
                    } 
                }
                else { delete mobs[data.id]; if (currentTargetId === data.id) currentTargetId = null; }
            }
            else if (data.action === "phase_change") {
                if (mobs[data.id]) mobs[data.id].phase = data.phase;
            }
            else if (data.action === "mob_move") {
                if (mobs[data.id]) { 
                    let m = mobs[data.id];
                    if (data.x > m.x) m.dir = 2;
                    else if (data.x < m.x) m.dir = 1;
                    else if (data.y > m.y) m.dir = 0;
                    else if (data.y < m.y) m.dir = 3;
                    if (m.x !== data.x || m.y !== data.y) m.moveFrame = ((m.moveFrame || 0) + 1) % 3;
                    m.x = data.x; m.y = data.y; 
                }
            }
            else if (data.action === "corpse_spawn") { clientCorpses[data.corpse.id] = data.corpse; }
            else if (data.action === "corpse_remove") { delete clientCorpses[data.id]; }
            else if (data.action === "chest_update") { if (data.active) chests[data.id] = { x: data.x, y: data.y }; else delete chests[data.id]; }
            else if (data.action === "item_dict") { itemDict = data; }
            else if (data.action === "npc_sync") { npcsLocal[data.id] = { x: data.x, y: data.y, name: data.name, id: data.id, hasQuest: data.hasQuest }; }
            else if (data.action === "node_sync") { gatherNodes[data.id] = { x: data.x, y: data.y, name: data.name, color: data.color, symbol: data.symbol }; }
            else if (data.action === "node_remove") { delete gatherNodes[data.id]; }
            else if (data.action === "players_sync") {
                let newIds = data.players.map(p => p.id);
                data.players.forEach(p => { 
                    if (p.id !== myId) {
                        if (!otherPlayers[p.id]) otherPlayers[p.id] = { x: p.x, y: p.y, renderX: p.x, renderY: p.y, classType: p.classType, name: p.name, warmode: p.warmode, dir: 0, moveFrame: 0, skulled: !!p.skulled, guild: p.guild || null, isMounted: !!p.isMounted };
                        else { 
                            let op = otherPlayers[p.id];
                            if (p.x > op.x) op.dir = 2;
                            else if (p.x < op.x) op.dir = 1;
                            else if (p.y > op.y) op.dir = 0;
                            else if (p.y < op.y) op.dir = 3;
                            if (op.x !== p.x || op.y !== p.y) op.moveFrame = ((op.moveFrame || 0) + 1) % 3;
                            op.x = p.x; op.y = p.y; op.classType = p.classType; op.warmode = p.warmode; 
                            op.skulled = !!p.skulled; op.guild = p.guild || null; op.isMounted = !!p.isMounted;
                        }
                    } else { player.x = p.x; player.y = p.y; player.classType = p.classType; player.warmode = p.warmode; player.skulled = !!p.skulled; player.isMounted = !!p.isMounted; }
                });
                for (let id in otherPlayers) { if (!newIds.includes(id)) delete otherPlayers[id]; }
            }
            else if (data.action === "auction_sync") { window.auctionItems = data.listings; if (window.renderAuctionUI) window.renderAuctionUI(); }
            else if (data.action === "mount_changed") {
                if (data.id === myId) player.isMounted = data.isMounted;
                else if (otherPlayers[data.id]) otherPlayers[data.id].isMounted = data.isMounted;
            }
            else if (data.action === "boss_spawned") {
                // Displaying a massive UI banner or shaking the screen
                audio.spellBlast(); // Boom sound
                addChat(Date.now(), "System", `⚠️ [GLOBAL ALERT] The terrifying ${data.name} has spawned!`);
            }
            else if (data.action === "auction_mailbox") {
                if (data.gold > 0 || (data.items && data.items.length > 0)) {
                    addChat(Date.now(), "System", `📬 You received ${data.gold}G and ${data.items ? data.items.length : 0} items from the Auction House!`);
                }
            }
            else if (data.action === "fishing_result") {
                if (data.success) {
                    addChat(Date.now(), "System", `🎣 You caught a ${data.item}!`);
                } else {
                    addChat(Date.now(), "System", `🎣 You caught an ${data.item}...`);
                }
            }
            else if (data.action === "fct") {
                floatingTextsLocal.push({ x: data.x, y: data.y, text: data.text, color: data.color, life: 1.0 });
            }
            else if (data.action === "damage") {
                // A hit landing on someone. The packet names a target and an
                // amount but carries no position, so the number has to be drawn
                // over whatever the client currently believes that target is.
                //
                // The floor scoping is free and is the reason this can be handled
                // at all: `mobs` and `otherPlayers` are cleared and refilled on
                // every floor change, so a target that is not in them is on
                // another floor and is ignored here. A player in the city cannot
                // be shown a hit landing on someone in the cave, and cannot be
                // shown a floating number over empty ground.
                const victim = mobs[data.targetId] || otherPlayers[data.targetId];
                if (victim && typeof data.amount === "number" && data.amount > 0) {
                    floatingTextsLocal.push({
                        x: victim.x + 16, y: victim.y - 20,
                        text: `-${Math.round(data.amount)}`, color: '#ff6b6b', life: 1.0
                    });
                }
            }
            else if (data.action === "player_left") { delete otherPlayers[data.id]; }
            else if (data.action === "player_update") {
                // Someone arrived on this floor, or changed while standing on it.
                // Without this they would not appear until the next roster tick,
                // up to 200ms later -- long enough to look like the server lost
                // them. Traversal is what sends it, so without handling it a
                // player who climbed a ladder stayed invisible to the floor they
                // arrived on for a fifth of a second.
                if (data.id === myId) return;
                const existing = otherPlayers[data.id];
                if (existing) {
                    existing.x = data.x; existing.y = data.y;
                    existing.classType = data.classType; existing.guild = data.guild || null;
                    existing.skulled = !!data.skulled; existing.isMounted = data.isMounted === true;
                } else {
                    otherPlayers[data.id] = {
                        x: data.x, y: data.y, renderX: data.x, renderY: data.y,
                        classType: data.classType, name: data.name, warmode: !!data.warmode,
                        dir: 0, moveFrame: 0, skulled: !!data.skulled,
                        guild: data.guild || null, isMounted: data.isMounted === true
                    };
                }
            }
            else if (data.action === "inventory_update") {
                // Loot landed. The periodic status would carry the same thing
                // within 300ms, so this is not a correctness fix so much as
                // removing a visible delay between picking something up and
                // seeing it in the pack.
                if (Array.isArray(data.inventory)) applyInventory(data.inventory);
                if (typeof data.gold === "number") applyGold(data.gold);
            }
            else if (data.action === "server_shutdown") {
                // The server is going away. Say so, instead of letting the socket
                // close and leaving the player to wonder whether they were
                // disconnected, kicked, or the game had crashed.
                addLog("⚠️ The server is shutting down. Reconnect in a moment.");
            }
            else if (data.action === "auth_logout_success") {
                addLog("👋 Signed out.");
            }
            else if (data.action === "status") {
                if (data.isMounted !== undefined) player.isMounted = data.isMounted;
                player.classType = data.classType;
                // Level-up fanfare fires on the transition, not every tick.
                if (lastKnownLevel && data.level > lastKnownLevel) audio.levelUp();
                if (lastKnownHp && data.hp < lastKnownHp) audio.hurt();
                lastKnownLevel = data.level;
                lastKnownHp = data.hp;
                myLevel = data.level;
                const evolveButton = document.getElementById("btn-evolve");
                if (evolveButton) evolveButton.disabled = Boolean(data.subclass) || data.level < 10;
                let subClsStr = data.subclass ? " - " + data.subclass.charAt(0).toUpperCase() + data.subclass.slice(1) : "";
                document.getElementById("player-level-title").innerText = "Lvl " + data.level + " " + data.classType.charAt(0).toUpperCase() + data.classType.slice(1) + subClsStr + " (" + myName + ")";
                document.getElementById("hp-bar").style.width = (data.hp/data.maxHp*100)+"%"; document.getElementById("hp-text").innerText = "HP: "+data.hp+"/"+data.maxHp;
                document.getElementById("mana-bar").style.width = (data.mana/data.maxMana*100)+"%"; document.getElementById("mana-text").innerText = "Mana: "+data.mana+"/"+data.maxMana;
                document.getElementById("xp-bar").style.width = (data.xp/data.nextXp*100)+"%"; document.getElementById("xp-text").innerText = "XP: "+data.xp+"/"+data.nextXp;
                
                applyGold(data.gold);
                
                const btnSkill = document.getElementById("btn-skill");
                if(data.classType==="warrior") btnSkill.innerText = "Cleave (Press 2)";
                else if(data.classType==="mage") btnSkill.innerText = "Fireball (Press 2)";
                else if(data.classType==="ranger") btnSkill.innerText = "Snipe (Press 2)";
                else if(data.classType==="healer") btnSkill.innerText = "💚 Heal (Press 2)";
                
                if (data.equipment) {
                    player.equipment = data.equipment;
                    const slots = ['helmet', 'amulet', 'weapon', 'shield', 'armor', 'legs', 'boots'];
                    slots.forEach(slot => {
                        const el = document.getElementById("equip-" + slot);
                        if (el) {
                            if (data.equipment[slot]) {
                                el.innerText = data.equipment[slot];
                                el.classList.add("filled");
                                el.title = getItemTooltip(data.equipment[slot]) + "\n(Click to unequip)";
                            } else {
                                el.innerText = slot.charAt(0).toUpperCase() + slot.slice(1);
                                el.classList.remove("filled");
                                el.removeAttribute("title");
                            }
                        }
                    });
                }
                
                speedBonus = data.speedBonus || 0;
                applyInventory(data.inventory || []);
            }
            else if (data.action === "chat") {
                const channelLabel = data.channel === "party" ? "[Party]" : data.channel === "zone" ? "[Zone]" : "[Global]";
                addLog(channelLabel + " " + (data.sender || data.name || "Player") + ": " + (data.text || ""), data.channel || "global");
            }
            else if (data.action === "quest_journal") { renderQuestJournal(data); }
            else if (data.action === "npc_dialogue") { showNPCDialog(data); }
            else if (data.action === "npc_dialogue_close") {
                activeNpcId = null;
                activeDialogueNode = null;
                document.getElementById("npc-dialog").style.display = "none";
                document.getElementById("overlay").style.display = "none";
            }
            else if (data.action === "log") {
                addLog(data.message);
                const msg = data.message || "";
                if (msg.includes("[QUEST]")) audio.questUpdate();
                else if (msg.includes("cannot") || msg.includes("Cannot") || msg.includes("must be near")) audio.error();
                else if (msg.includes("Received:")) audio.loot();
            }
            else if (data.action === "open_shop") {
                document.getElementById("overlay").style.display = "block";
                document.getElementById("shop-modal").style.display = "block";
                applyGold(data.gold);
                audio.coin();
                
                let buyHtml = "";
                for (let item in data.inventory) {
                    const price = data.inventory[item].price;
                    buyHtml += "<div style='display:flex; justify-content:space-between; margin-bottom:5px;'><span>" + escapeHtml(item) + "</span><button onclick='shopBuy(\"" + escapeHtml(item) + "\")' style='background:#44aa44; border:none; color:white; padding:2px 5px; cursor:pointer'>" + price + "G</button></div>";
                }
                document.getElementById("shop-buy-list").innerHTML = buyHtml;
                renderShopSellList();
            }
            else if (data.action === "skill_update") {
                // Two shapes: a full panel on login, or one skill after an award.
                if (Array.isArray(data.skills)) renderSkillPanel(data.skills);
                else if (data.skill) applySkillUpdate(data.skill);
            }
            else if (data.action === "crafting_open") { openCrafting(data); }
            else if (data.action === "crafting_sync") {
                renderCraftingList(data.recipes);
                if (Array.isArray(data.inventory)) {
                    myInventoryData = data.inventory;
                    const invEl = document.getElementById("inventory-list");
                    if (myInventoryData.length > 0) {
                        const counts = {};
                        myInventoryData.forEach(i => counts[i] = (counts[i] || 0) + 1);
                        invEl.innerHTML = Object.keys(counts).map(k =>
                            "<div class='inv-item' draggable='true' ondragstart='window.dragStart(event, \"" + escapeHtml(k).replace(/'/g, "&#39;") + "\")' style='cursor:pointer' onclick='clickItem(\"" + escapeHtml(k).replace(/'/g, "&#39;") + "\")' title='" + escapeHtml(getItemTooltip(k)).replace(/'/g, "&#39;") + "\n(Click to equip/use)'>" + escapeHtml(k) + " x" + counts[k] + "</div>"
                        ).join("");
                    } else {
                        invEl.innerHTML = "<em style=\"color:#666\">Empty</em>";
                    }
                }
                audio.questUpdate();
            }
            else if (data.action === "shop_sync") {
                applyGold(data.gold);
                renderShopSellList();
            }
        };

        window.processPacketQueue = () => {
            packetQueue.forEach(socket.onmessage);
            packetQueue = [];
        };

        // Renders the pack panel from a new inventory list.
        //
        // Extracted from the status handler so that inventory_update and status
        // cannot drift apart: they are two doors onto the same state, and when
        // the rendering lived inside one of them the other could only ever
        // update the variable and not the panel.
        function applyInventory(items) {
            myInventoryData = items || [];
            const invEl = document.getElementById("inventory-list");
            if (!invEl) return;
            if (myInventoryData.length > 0) {
                const counts = {};
                myInventoryData.forEach(i => counts[i] = (counts[i] || 0) + 1);
                invEl.innerHTML = Object.keys(counts).map(k =>
                    "<div class='inv-item' draggable='true' ondragstart='window.dragStart(event, \"" + escapeHtml(k).replace(/'/g, "&#39;") + "\")' style='cursor:pointer' onclick='clickItem(\"" + escapeHtml(k).replace(/'/g, "&#39;") + "\")' title='" + escapeHtml(getItemTooltip(k)).replace(/'/g, "&#39;") + "\n(Click to equip/use)'>" + escapeHtml(k) + " x" + counts[k] + "</div>"
                ).join("");
            } else {
                invEl.innerHTML = "<em style=\"color:#666\">Empty</em>";
            }
        }

        function applyGold(amount) {
            myGold = amount;
            const hud = document.getElementById("gold-val");
            if (hud) hud.innerText = myGold;
            const shop = document.getElementById("shop-player-gold");
            if (shop) shop.innerText = myGold;
        }

        // Read-only snapshot of the client's own world caches, for the browser
        // acceptance tests. Same role as window.currentZ and
        // window.processPacketQueue: without it, a test can only confirm that a
        // floor change made the canvas *look* different, which is satisfied
        // equally well by a client that forgot to drop the surface roster and
        // is drawing it one floor too low. Reading the client's own state back
        // is what distinguishes the two. Deliberately read-only -- it must not be
        // able to move anything, or it would stop being a probe.
        window.__worldSnapshot = () => ({
            z: window.currentZ,
            mobs: Object.keys(mobs).length,
            // Ids, not just a count: a client that kept the surface roster and
            // merged the dungeon's on top of it would show a *plausible* count,
            // so the count alone cannot detect a failed flush. Comparing these
            // against the ids the server was known to have on the surface can.
            mobIds: Object.keys(mobs),
            otherPlayers: Object.keys(otherPlayers).length,
            corpses: Object.keys(clientCorpses).length,
            groundItems: groundItemsLocal.length,
            obstacles: (obstacles || []).length,
            obstacleTypes: [...new Set((obstacles || []).map(o => o.type))].sort(),
            transitions: floorTransitions.map(t => ({ x: t.x, y: t.y, type: t.type, to: t.to })),
            bounds: MAP_BOUNDS ? Object.assign({}, MAP_BOUNDS) : null,
            mapW: MAP_W,
            mapH: MAP_H,
            player: player ? { x: player.x, y: player.y } : null
        });
        
        // --- End of socket logic ---

        function shopBuy(itemName) {
            audio.coin();
            socket.send(JSON.stringify({ action: "buy_item", item: itemName }));
        }
        function shopSell(itemName) {
            audio.coin();
            socket.send(JSON.stringify({ action: "sell_item", item: itemName }));
        }

        function clickItem(name) {
            if (activeTradeId) {
                stageTradeItem(name);
                return;
            }
            if (name.includes("Potion")) useItem(name);
            else socket.send(JSON.stringify({ action: "equip_item", item: name }));
        }
        function stageTradeItem(itemName) {
            if (!activeTradeId || tradeLocked) return;
            socket.send(JSON.stringify({ action: "trade_add_item", tradeId: activeTradeId, item: itemName }));
        }
        function unequip(slot) { socket.send(JSON.stringify({ action: "unequip_item", slot: slot })); }
        function useItem(itemName) { socket.send(JSON.stringify({ action: "use_item", item: itemName })); }
        function castPurify() {
            audio.spellBlast();
            socket.send(JSON.stringify({ action: "cast_purify" }));
        }
        function castSkill() {
            audio.spellBlast();
            if (player.classType === "healer") socket.send(JSON.stringify({ action: "cast_heal" }));
            else socket.send(JSON.stringify({ action: "cast_spell" }));
        }
        function requestEvolve() {
            socket.send(JSON.stringify({ action: "evolve" }));
        }

        function updateTradeGold() {
            socket.send(JSON.stringify({
                action: "trade_set_gold",
                tradeId: activeTradeId,
                amount: Number(document.getElementById("trade-my-gold").value) || 0
            }));
        }
        function lockTrade() {
            if (!activeTradeId || tradeLocked) return;
            socket.send(JSON.stringify({ action: "trade_lock", tradeId: activeTradeId }));
        }
        function acceptTradeRequest() {
            if (!pendingTradeRequest) return;
            socket.send(JSON.stringify({
                action: "trade_accept",
                requestId: pendingTradeRequest.requestId,
                fromPlayer: pendingTradeRequest.fromPlayer
            }));
            document.getElementById("trade-request-actions").style.display = "none";
        }
        function declineTradeRequest() {
            if (pendingTradeRequest) {
                socket.send(JSON.stringify({
                    action: "trade_decline",
                    requestId: pendingTradeRequest.requestId,
                    fromPlayer: pendingTradeRequest.fromPlayer
                }));
            }
            pendingTradeRequest = null;
            document.getElementById("trade-request-actions").style.display = "none";
            document.getElementById("overlay").style.display = "none";
            document.getElementById("trade-modal").style.display = "none";
        }
        function confirmTrade() {
            if (!activeTradeId || !tradeLocked) return;
            socket.send(JSON.stringify({ action: "trade_confirm", tradeId: activeTradeId }));
        }
        function cancelTrade() { socket.send(JSON.stringify({ action: "trade_cancel", tradeId: activeTradeId })); }
        function leaveParty() { socket.send(JSON.stringify({ action: "party_leave" })); }
        function acceptPartyInvite() {
            if (!pendingPartyInvite) return;
            socket.send(JSON.stringify({ action: "party_accept", partyId: pendingPartyInvite.partyId }));
            pendingPartyInvite = null;
            renderParty({ members: [] });
        }
        function declinePartyInvite() {
            if (!pendingPartyInvite) return;
            socket.send(JSON.stringify({ action: "party_decline", partyId: pendingPartyInvite.partyId }));
            pendingPartyInvite = null;
            renderParty({ members: [] });
        }
        function selectSubclass(sc) { socket.send(JSON.stringify({ action: "select_subclass", subclassId: sc })); }

        function submitAuth(type) {
            const user = document.getElementById("auth-username").value;
            const pass = document.getElementById("auth-password").value;
            if (!user || !pass) {
                document.getElementById("auth-error").innerText = "Please enter username and password.";
                return;
            }
            document.getElementById("auth-error").innerText = "Loading...";
            socket.send(JSON.stringify({ action: "auth_" + type, username: user, password: pass }));
        }

        function login(cls) {
            const name = document.getElementById("char-name").value;
            const warmode = document.getElementById("warmode").checked;
            document.getElementById("overlay").style.display = "none";
            document.getElementById("class-modal").style.display = "none";
            socket.send(JSON.stringify({ action: "login", class: cls, name: name, warmode: warmode, authToken: authToken }));
        }

        let lastMoveTime = 0;
        function isWalkable(nx, ny) {
            if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) return false;
            if (MAP_BOUNDS) {
                if (nx < MAP_BOUNDS.minX || nx > MAP_BOUNDS.maxX || ny < MAP_BOUNDS.minY || ny > MAP_BOUNDS.maxY) return false;
            }
            return !obstacleSet.has(nx + "," + ny);
        }

        let pathQueue = [];
        function findPath(sx, sy, gx, gy) {
            sx = Math.floor(sx / 32) * 32;
            sy = Math.floor(sy / 32) * 32;
            gx = Math.floor(gx / 32) * 32;
            gy = Math.floor(gy / 32) * 32;

            if (!isWalkable(gx, gy)) return []; 
            
            let open = [{x: sx, y: sy, path: []}];
            let closed = new Set();
            closed.add(sx+","+sy);

            let iterations = 0;
            while(open.length > 0 && iterations < 800) {
                let curr = open.shift();
                iterations++;
                if (curr.x === gx && curr.y === gy) return curr.path;
                
                const dirs = [[0,-32],[0,32],[-32,0],[32,0]];
                for (let d of dirs) {
                    let nx = curr.x + d[0], ny = curr.y + d[1];
                    let key = nx+","+ny;
                    if (!closed.has(key) && isWalkable(nx, ny)) {
                        closed.add(key);
                        open.push({x: nx, y: ny, path: [...curr.path, {x: nx, y: ny}]});
                    }
                }
            }
            return [];
        }

        setInterval(() => {
            if (!myId || !player) return;
            if (pathQueue.length > 0) {
                const now = Date.now();
                const clientMoveSpeed = Math.max(80, 300 - (myLevel * 3) - speedBonus) + 10;
                if (now - lastMoveTime >= clientMoveSpeed) {
                    let next = pathQueue.shift();
                    let dx = next.x - player.x;
                    let dy = next.y - player.y;

                    if (Math.abs(dx) > 32 || Math.abs(dy) > 32) { pathQueue = []; return; } // Validation check

                    if (dy > 0) player.dir = 0;
                    else if (dy < 0) player.dir = 3;
                    else if (dx > 0) player.dir = 2;
                    else if (dx < 0) player.dir = 1;

                    lastMoveTime = now;
                    player.x = next.x; player.y = next.y; 
                    player.moveFrame = ((player.moveFrame || 0) + 1) % 3;
                    audio.footstep();
                    socket.send(JSON.stringify({ action: "move", x: next.x, y: next.y }));
                }
            }
        }, 50);

        document.addEventListener("keydown", (e) => {
            if (document.getElementById("overlay").style.display === "block") return;
            if (document.activeElement === chatInput) {
                if (e.key === "Enter" && chatInput.value.trim() !== "") {
                    let text = chatInput.value.trim();
                    let channel = "global";
                    if (text.startsWith("/p ")) { channel = "party"; text = text.substring(3); }
                    else if (text.startsWith("/z ")) { channel = "zone"; text = text.substring(3); }
                    else if (text.startsWith("/g ")) { channel = "global"; text = text.substring(3); }
                    socket.send(JSON.stringify({ action: "chat", text: text, channel: channel }));
                    chatInput.value = "";
                }
                return;
            }

            if (!myId) return;
            const now = Date.now();
            let dx = 0, dy = 0;
            if (e.key === "ArrowUp" || e.key === "w") dy = -32;
            else if (e.key === "ArrowDown" || e.key === "s") dy = 32;
            else if (e.key === "ArrowLeft" || e.key === "a") dx = -32;
            else if (e.key === "ArrowRight" || e.key === "d") dx = 32;
            else if (e.key === "Enter") chatInput.focus();
if (e.key === "1") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 1 })); return; }
            if (e.key === "2") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 2 })); return; }
            if (e.key === "r" || e.key === "R") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 3 })); return; }
            if (e.key === "z" || e.key === "Z") { socket.send(JSON.stringify({ action: "toggle_mount" })); return; }
            if (e.key === "f" || e.key === "F") { socket.send(JSON.stringify({ action: "fish" })); return; }
            
            if (dx||dy) {
                pathQueue = []; // Cancel pathfinding on manual input
                const clientMoveSpeed = Math.max(80, 300 - (myLevel * 3) - speedBonus) + 10;
                if (now - lastMoveTime < clientMoveSpeed) return;
                
                if (dy > 0) player.dir = 0;
                else if (dy < 0) player.dir = 3;
                else if (dx > 0) player.dir = 2;
                else if (dx < 0) player.dir = 1;

                const nx = player.x + dx, ny = player.y + dy;
                if (isWalkable(nx, ny)) {
                    lastMoveTime = now;
                    player.x = nx; player.y = ny; 
                    player.moveFrame = ((player.moveFrame || 0) + 1) % 3;
                    audio.footstep();
                    socket.send(JSON.stringify({ action: "move", x: nx, y: ny }));
                }
            }

            if (e.key === "1") castPurify();
            if (e.key === "2") castSkill();
            if (e.key === "m" || e.key === "M") toggleAudio();
            if (e.key === "Tab") { 
                e.preventDefault(); 
                toggleMinimap(); 
            }
            if (e.key === "3") useItem("Health Potion");
            if (e.key === "4") useItem("Mana Potion");
            if (e.key === "Escape") currentTargetId = null;
            if (e.key === "e" || e.key === "E") {
                for(let id in clientCorpses) {
                    if(Math.abs(player.x - clientCorpses[id].x) + Math.abs(player.y - clientCorpses[id].y) <= 64) {
                        socket.send(JSON.stringify({ action: "interact_corpse", id: id }));
                        return;
                    }
                }
                for(let id in npcsLocal) {
                    const npc = npcsLocal[id];
                    if(Math.abs(player.x - npc.x) + Math.abs(player.y - npc.y) <= 96) {
                        socket.send(JSON.stringify({ action: "talk_npc", npc_id: id }));
                        break;
                    }
                }
            }
        });

        canvas.addEventListener("mousedown", (e) => {
            if (document.getElementById("overlay").style.display === "block") return;
            const rect = canvas.getBoundingClientRect();
            const clickX = e.clientX - rect.left + cameraX;
            const clickY = e.clientY - rect.top + cameraY;

            let clicked = null;
            
            for (let i = 0; i < groundItemsLocal.length; i++) {
                const item = groundItemsLocal[i];
                if (clickX >= item.x && clickX <= item.x + 24 && clickY >= item.y && clickY <= item.y + 24) {
                    socket.send(JSON.stringify({ action: "pickup_item", itemId: item.id }));
                    return;
                }
            }

            for (let id in npcsLocal) {
                if (clickX >= npcsLocal[id].x && clickX <= npcsLocal[id].x + 32 && clickY >= npcsLocal[id].y && clickY <= npcsLocal[id].y + 32) {
                    socket.send(JSON.stringify({ action: "talk_npc", npc_id: id }));
                    return;
                }
            }
            
            for (let id in mobs) {
                if (clickX >= mobs[id].x && clickX <= mobs[id].x + 32 && clickY >= mobs[id].y && clickY <= mobs[id].y + 32) { clicked = id; break; }
            }
            if (!clicked) {
                for (let id in otherPlayers) {
                    if (clickX >= otherPlayers[id].x && clickX <= otherPlayers[id].x + 32 && clickY >= otherPlayers[id].y && clickY <= otherPlayers[id].y + 32) { clicked = id; break; }
                }
                
                if (!clicked) {
                    // Click to move!
                    pathQueue = findPath(player.x, player.y, clickX, clickY);
                }
            }
            
            if (clicked) {
                currentTargetId = clicked;
                socket.send(JSON.stringify({ action: "attack", target_id: currentTargetId }));
            }
        });

        canvas.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            if (document.getElementById("overlay").style.display === "block") return;
            const rect = canvas.getBoundingClientRect();
            const clickX = e.clientX - rect.left + cameraX;
            const clickY = e.clientY - rect.top + cameraY;
            for (const id in otherPlayers) {
                const other = otherPlayers[id];
                if (clickX >= other.x && clickX <= other.x + 32 && clickY >= other.y && clickY <= other.y + 32) {
                    socket.send(JSON.stringify({ action: "trade_request", targetName: other.name }));
                    return;
                }
            }
        });
