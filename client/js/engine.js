        const canvas = document.getElementById("gameCanvas");
        const ctx = canvas.getContext("2d");
        const chatInput = document.getElementById("chat-input");

        const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(socketProtocol + "//" + window.location.host);

        let MAP_W = 3200, MAP_H = 3200;
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
        let npcsLocal = {};
        
        let obstacles = [];
        let obstacleSet = new Set();
        let fcts = [];
        let currentTargetId = null;
        let cameraX = 0, cameraY = 0;
        let isDay = true;
        
        let authToken = null;
        let myGold = 0;
        let myInventoryData = [];
        let bossAoeEffects = [];
        let activeSpells = [];

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            
            if (data.action === "login_error" || data.action === "auth_error") {
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
            else if (data.action === "trade_sync" || data.action === "trade_update") {
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
            else if (data.action === "map_data") { 
                obstacles = data.obstacles; 
                if (data.width) MAP_W = data.width;
                if (data.height) MAP_H = data.height;
                if (data.safeZone) SAFE_ZONE = data.safeZone;
                obstacleSet.clear();
                obstacles.forEach(o => obstacleSet.add(o.x + "," + o.y));
            }
            else if (data.action === "time_sync") { isDay = data.isDay; }
            else if (data.action === "fct") {
                fcts.push({ text: data.text, x: data.x, y: data.y, color: data.color, life: 1.0, driftX: (Math.random() - 0.5) * 40 });
                // Floating combat text is how the server reports loot and XP.
                if (/^\+.*Gold$|^\+\d+G$/.test(data.text || "")) audio.loot();
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
            else if (data.action === "your_id") { myId = data.id; myName = data.name; }
            else if (data.action === "force_position") { player.x = data.x; player.y = data.y; }
            else if (data.action === "mob_update") {
                if (data.alive) { 
                    if(!mobs[data.id]) mobs[data.id] = { x: data.x, y: data.y, id: data.id, hp: data.hp, maxHp: data.maxHp, isElite: data.isElite, isBoss: data.isBoss, name: data.name, type: data.type, phase: data.phase || 1, renderX: data.x, renderY: data.y }; 
                    else { mobs[data.id].hp = data.hp; mobs[data.id].maxHp = data.maxHp; mobs[data.id].x = data.x; mobs[data.id].y = data.y; } 
                }
                else { delete mobs[data.id]; if (currentTargetId === data.id) currentTargetId = null; }
            }
            else if (data.action === "phase_change") {
                if (mobs[data.id]) mobs[data.id].phase = data.phase;
            }
            else if (data.action === "mob_move") {
                if (mobs[data.id]) { mobs[data.id].x = data.x; mobs[data.id].y = data.y; }
            }
            else if (data.action === "corpse_spawn") { clientCorpses[data.corpse.id] = data.corpse; }
            else if (data.action === "corpse_remove") { delete clientCorpses[data.id]; }
            else if (data.action === "chest_update") { if (data.active) chests[data.id] = { x: data.x, y: data.y }; else delete chests[data.id]; }
            else if (data.action === "npc_sync") { npcsLocal[data.id] = { x: data.x, y: data.y, name: data.name, id: data.id }; }
            else if (data.action === "node_sync") { gatherNodes[data.id] = { x: data.x, y: data.y, name: data.name, color: data.color, symbol: data.symbol }; }
            else if (data.action === "node_remove") { delete gatherNodes[data.id]; }
            else if (data.action === "players_sync") {
                let newIds = data.players.map(p => p.id);
                data.players.forEach(p => { 
                    if (p.id !== myId) {
                        if (!otherPlayers[p.id]) otherPlayers[p.id] = { x: p.x, y: p.y, renderX: p.x, renderY: p.y, classType: p.classType, name: p.name, warmode: p.warmode };
                        else { otherPlayers[p.id].x = p.x; otherPlayers[p.id].y = p.y; otherPlayers[p.id].classType = p.classType; otherPlayers[p.id].warmode = p.warmode; }
                    } else { player.x = p.x; player.y = p.y; player.classType = p.classType; player.warmode = p.warmode; }
                });
                for (let id in otherPlayers) { if (!newIds.includes(id)) delete otherPlayers[id]; }
            }
            else if (data.action === "player_left") { delete otherPlayers[data.id]; }
            else if (data.action === "status") {
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
                
                myGold = data.gold;
                document.getElementById("gold-val").innerText = myGold;
                
                const btnSkill = document.getElementById("btn-skill");
                if(data.classType==="warrior") btnSkill.innerText = "Cleave (Press 2)";
                else if(data.classType==="mage") btnSkill.innerText = "Fireball (Press 2)";
                else if(data.classType==="ranger") btnSkill.innerText = "Snipe (Press 2)";
                else if(data.classType==="healer") btnSkill.innerText = "💚 Heal (Press 2)";
                
                if (data.equipment) {
                    const slots = ['helmet', 'amulet', 'weapon', 'shield', 'armor', 'legs', 'boots'];
                    slots.forEach(slot => {
                        const el = document.getElementById("eq-" + slot);
                        if (el) {
                            if (data.equipment[slot]) {
                                el.innerText = data.equipment[slot];
                                el.classList.add("filled");
                            } else {
                                el.innerText = slot.charAt(0).toUpperCase() + slot.slice(1);
                                el.classList.remove("filled");
                            }
                        }
                    });
                }
                
                speedBonus = data.speedBonus || 0;
                myInventoryData = data.inventory || [];
                
                const invEl = document.getElementById("inventory-list");
                if (myInventoryData.length > 0) {
                    let counts = {}; myInventoryData.forEach(i => counts[i] = (counts[i]||0)+1);
                    invEl.innerHTML = Object.keys(counts).map(k => 
                        "<div class='inv-item' style='cursor:pointer' onclick='clickItem(\"" + escapeHtml(k).replace(/'/g, "&#39;") + "\")' title='Click to equip/use'>" + escapeHtml(k) + " x" + counts[k] + "</div>"
                    ).join("");
                } else { invEl.innerHTML = "<em style=\"color:#666\">Empty</em>"; }
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
                document.getElementById("shop-player-gold").innerText = data.gold;
                audio.coin();
                
                let buyHtml = "";
                for (let item in data.inventory) {
                    const price = data.inventory[item].price;
                    buyHtml += "<div style='display:flex; justify-content:space-between; margin-bottom:5px;'><span>" + escapeHtml(item) + "</span><button onclick='shopBuy(\"" + escapeHtml(item) + "\")' style='background:#44aa44; border:none; color:white; padding:2px 5px; cursor:pointer'>" + price + "G</button></div>";
                }
                document.getElementById("shop-buy-list").innerHTML = buyHtml;
                renderShopSellList();
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
                            "<div class='inv-item' style='cursor:pointer' onclick='clickItem(\"" + escapeHtml(k).replace(/'/g, "&#39;") + "\")' title='Click to equip/use'>" + escapeHtml(k) + " x" + counts[k] + "</div>"
                        ).join("");
                    } else {
                        invEl.innerHTML = "<em style=\"color:#666\">Empty</em>";
                    }
                }
                audio.questUpdate();
            }
            else if (data.action === "shop_sync") {
                myGold = data.gold;
                document.getElementById("shop-player-gold").innerText = data.gold;
                renderShopSellList();
            }
        };

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
            return !obstacleSet.has(nx + "," + ny);
        }

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
            
            if (dx||dy) {
                const clientMoveSpeed = Math.max(80, 300 - (myLevel * 3) - speedBonus) + 10;
                if (now - lastMoveTime < clientMoveSpeed) return;
                
                const nx = player.x + dx, ny = player.y + dy;
                if (isWalkable(nx, ny)) {
                    lastMoveTime = now;
                    player.x = nx; player.y = ny; 
                    socket.send(JSON.stringify({ action: "move", x: nx, y: ny }));
                }
            }

            if (e.key === "1") castPurify();
            if (e.key === "2") castSkill();
            if (e.key === "m" || e.key === "M") toggleAudio();
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
