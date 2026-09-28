        // === AudioManager ===
        // Everything is synthesized with the Web Audio API, so there are no
        // asset files to ship. The context stays suspended until the first
        // real user gesture, which is what browsers require before audio.
        class AudioManager {
            constructor() {
                this.ctx = null;
                this.master = null;
                this.musicGain = null;
                this.sfxGain = null;
                this.muted = false;
                this.musicNodes = null;
                this.musicTimer = null;
                this.started = false;
                this.step = 0;
                this.lastPlay = {};
            }

            // Must be called from a user gesture handler the first time.
            init() {
                if (this.started) return true;
                const Ctor = window.AudioContext || window.webkitAudioContext;
                if (!Ctor) return false;
                try {
                    this.ctx = new Ctor();
                } catch (e) {
                    return false;
                }
                this.master = this.ctx.createGain();
                this.master.gain.value = this.muted ? 0 : 0.5;
                this.master.connect(this.ctx.destination);

                this.musicGain = this.ctx.createGain();
                this.musicGain.gain.value = 0.16;
                this.musicGain.connect(this.master);

                this.sfxGain = this.ctx.createGain();
                this.sfxGain.gain.value = 0.5;
                this.sfxGain.connect(this.master);

                this.started = true;
                if (this.ctx.state === 'suspended') this.ctx.resume();
                return true;
            }

            resume() {
                if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
            }

            setMuted(muted) {
                this.muted = !!muted;
                if (this.master) {
                    const now = this.ctx.currentTime;
                    this.master.gain.cancelScheduledValues(now);
                    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, now, 0.02);
                }
                const btn = document.getElementById('audio-toggle');
                if (btn) {
                    btn.innerHTML = this.muted ? '&#128263;' : '&#128266;';
                    btn.classList.toggle('muted', this.muted);
                    btn.title = this.muted ? 'Sound off (M)' : 'Sound on (M)';
                }
            }

            toggleMute() {
                this.init();
                this.setMuted(!this.muted);
                return this.muted;
            }

            // Rate limit so a burst of events cannot stack into a click storm.
            throttled(key, ms) {
                const now = Date.now();
                if (this.lastPlay[key] && now - this.lastPlay[key] < ms) return false;
                this.lastPlay[key] = now;
                return true;
            }

            // One oscillator note with an ADSR-ish envelope.
            tone(opts) {
                if (!this.started || this.muted) return;
                const o = {
                    freq: 440, type: 'sine', duration: 0.2, gain: 0.3,
                    dest: this.sfxGain, slideTo: null, delay: 0, attack: 0.01, ...opts
                };
                if (!o.dest) return;
                const t0 = this.ctx.currentTime + o.delay;
                const osc = this.ctx.createOscillator();
                const g = this.ctx.createGain();
                osc.type = o.type;
                osc.frequency.setValueAtTime(o.freq, t0);
                if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.slideTo), t0 + o.duration);
                g.gain.setValueAtTime(0.0001, t0);
                g.gain.exponentialRampToValueAtTime(o.gain, t0 + o.attack);
                g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.duration);
                osc.connect(g);
                g.connect(o.dest);
                osc.start(t0);
                osc.stop(t0 + o.duration + 0.02);
            }

            // Filtered white noise for percussive/impact sounds.
            noise(opts) {
                if (!this.started || this.muted) return;
                const o = { duration: 0.2, gain: 0.2, dest: this.sfxGain, filter: 1200, type: 'lowpass', delay: 0 };
                Object.assign(o, opts);
                if (!o.dest) return;
                const t0 = this.ctx.currentTime + o.delay;
                const frames = Math.max(1, Math.floor(this.ctx.sampleRate * o.duration));
                const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < frames; i++) {
                    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
                }
                const src = this.ctx.createBufferSource();
                src.buffer = buffer;
                const biquad = this.ctx.createBiquadFilter();
                biquad.type = o.type;
                biquad.frequency.value = o.filter;
                const g = this.ctx.createGain();
                g.gain.value = o.gain;
                src.connect(biquad);
                biquad.connect(g);
                g.connect(o.dest);
                src.start(t0);
            }

            // --- Sound effects ---

            swordSwoosh() {
                if (!this.throttled('swoosh', 90)) return;
                this.noise({ duration: 0.22, gain: 0.22, filter: 2600, type: 'bandpass' });
                this.tone({ freq: 900, slideTo: 260, type: 'triangle', duration: 0.18, gain: 0.1 });
            }

            spellBlast() {
                if (!this.throttled('blast', 90)) return;
                this.tone({ freq: 180, slideTo: 60, type: 'sawtooth', duration: 0.34, gain: 0.24 });
                this.noise({ duration: 0.3, gain: 0.18, filter: 900 });
            }

            coin() {
                // Two quick high notes read as a "cha-ching".
                this.tone({ freq: 1180, type: 'triangle', duration: 0.09, gain: 0.16 });
                this.tone({ freq: 1760, type: 'triangle', duration: 0.16, gain: 0.14, delay: 0.07 });
            }

            levelUp() {
                if (!this.throttled('levelup', 400)) return;
                [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
                    this.tone({ freq: f, type: 'triangle', duration: 0.34, gain: 0.2, delay: i * 0.11 });
                });
            }

            hit() {
                if (!this.throttled('hit', 70)) return;
                this.noise({ duration: 0.1, gain: 0.2, filter: 700 });
            }

            hurt() {
                if (!this.throttled('hurt', 260)) return;
                this.tone({ freq: 220, slideTo: 90, type: 'square', duration: 0.24, gain: 0.16 });
            }

            questUpdate() {
                if (!this.throttled('quest', 300)) return;
                this.tone({ freq: 660, type: 'sine', duration: 0.16, gain: 0.12 });
                this.tone({ freq: 880, type: 'sine', duration: 0.22, gain: 0.12, delay: 0.12 });
            }

            loot() {
                this.coin();
            }

            error() {
                if (!this.throttled('error', 400)) return;
                this.tone({ freq: 200, type: 'square', duration: 0.14, gain: 0.1 });
            }

            footstep() {
                if (!this.throttled('footstep', 100)) return;
                this.noise({ duration: 0.05, gain: 0.08, filter: 300 });
            }

            // --- Background music ---
            // A slow drifting arpeggio over a soft drone. Scheduled with
            // setInterval so it keeps time regardless of render frames.
            startMusic() {
                if (!this.started || this.musicTimer) return;
                const bass = [110, 130.81, 98, 146.83];
                const arp = [440, 523.25, 659.25, 523.25, 587.33, 440, 659.25, 523.25];
                this.musicTimer = setInterval(() => {
                    if (!this.started || this.muted || !this.ctx || this.ctx.state !== 'running') return;
                    const bar = Math.floor(this.step / 8) % bass.length;
                    this.tone({ freq: bass[bar], type: 'sine', duration: 1.6, gain: 0.22, dest: this.musicGain, attack: 0.35 });
                    const note = arp[this.step % arp.length];
                    this.tone({ freq: note, type: 'triangle', duration: 0.5, gain: 0.08, dest: this.musicGain, delay: 0.02 });
                    this.step++;
                }, 420);
            }

            stopMusic() {
                if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
            }
        }

        const audio = new AudioManager();

        // === Skills panel ===
        // The server owns skill levels and sends two shapes on skill_update:
        // a full panel on login ({ skills: [...] }) and a single skill after
        // an award ({ skill: {...} }). Both are handled here.
        let skillState = [];

        function renderSkillPanel(skills) {
            if (!Array.isArray(skills)) return;
            skillState = skills;
            const el = document.getElementById("skill-list");
            if (!el) return;
            if (skillState.length === 0) {
                el.innerHTML = "<em style='color:#666;font-size:11px'>No skills yet.</em>";
                return;
            }
            el.innerHTML = skillState.map(s => {
                const maxed = !s.xpForNext;
                const pct = maxed ? 100 : Math.min(100, Math.floor((s.xp / s.xpForNext) * 100));
                return `<div class="skill-row${maxed ? ' maxed' : ''}" data-skill="${escapeHtml(s.skill)}">
                    <div class="skill-head"><span>${escapeHtml(s.name)}</span><span class="skill-level">${maxed ? 'MAX' : 'Lv ' + escapeHtml(String(s.level))}</span></div>
                    <div class="skill-bar"><div style="width:${pct}%"></div></div>
                </div>`;
            }).join("");
        }

        // A single-skill award: update that row in place and flash it.
        function applySkillUpdate(skill) {
            if (!skill || typeof skill.skill !== 'string') return;
            const index = skillState.findIndex(s => s.skill === skill.skill);
            if (index === -1) return;
            skillState[index] = {
                skill: skill.skill,
                name: skill.name,
                level: skill.level,
                xp: skill.xp,
                xpForNext: skill.xpForNext,
                maxLevel: skill.maxLevel
            };
            renderSkillPanel(skillState);
            const row = document.querySelector(`.skill-row[data-skill="${skill.skill}"]`);
            if (row) {
                row.style.transition = 'none';
                row.style.background = skill.leveled ? 'rgba(251,191,36,0.18)' : 'transparent';
                setTimeout(() => {
                    row.style.transition = 'background 0.8s ease';
                    row.style.background = 'transparent';
                }, 60);
            }
            if (skill.leveled) {
                addLog(`⭐ ${skill.name} is now level ${skill.level}!`, 'system');
            }
        }

        function toggleAudio() {
            const muted = audio.toggleMute();
            if (!muted) audio.startMusic();
            addLog(muted ? '🔇 Sound muted' : '🔊 Sound enabled');
        }

        let activeNpcId = null;
        let activeDialogueNode = null;
        let activeTradeId = null;
        let tradeLocked = false;
        let pendingTradeRequest = null;
        let pendingPartyInvite = null;
        let myGuild = null;

        function escapeHtml(value) {
            return String(value ?? "").replace(/[&<>'"]/g, character => ({
                "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
            }[character]));
        }

        let chatMessages = [];
        let activeChatTab = "all";

        function setChatTab(tab) {
            activeChatTab = tab;
            ["all", "global", "zone", "party", "guild", "system"].forEach(t => {
                document.getElementById("tab-" + t).style.color = (t === tab) ? "#fff" : "#aaa";
                document.getElementById("tab-" + t).style.borderBottom = (t === tab) ? "2px solid #3b82f6" : "none";
            });
            renderChat();
        }

        function renderChat() {
            const c = document.getElementById("log-container");
            c.innerHTML = "";
            chatMessages.forEach(msg => {
                if (activeChatTab === "all" || msg.channel === activeChatTab || (activeChatTab==="system" && msg.channel==="system")) {
                    const d = document.createElement("div");
                    d.innerText = msg.text;
                    d.style.color = msg.color;
                    c.appendChild(d);
                }
            });
            c.scrollTop = c.scrollHeight;
        }

        function addLog(msg, channel="system") {
            let color = "#fff";
            if(msg.includes("DIED") || msg.includes("slain")) color = "#ff4444";
            else if(msg.includes("Gold") || msg.includes("XP")) color = "#ffd700";
            else if(msg.includes("QUEST")) color = "#ffcc44";
            else if(msg.includes("Equipped")) color = "#aaffaa";
            else if(channel === "guild" || msg.startsWith("[Guild]")) { color = "#ff8800"; channel = "guild"; }
            else if(channel === "party" || msg.startsWith("[Party]")) { color = "#00ff00"; channel = "party"; }
            else if(channel === "zone" || msg.startsWith("[Zone]")) { color = "#00ffff"; channel = "zone"; }
            else if(channel === "global") { color = "#ffffff"; }
            
            chatMessages.push({ text: msg, channel: channel, color: color });
            if (chatMessages.length > 100) chatMessages.shift();
            renderChat();
        }


        function handleBossAoe(data) {
            const id = data.id || data.spellId;
            if (!id) return;
            const phase = data.phase === "detonate" || data.action === "aoe_impact" ? "detonate" : "warning";
            if (phase === "warning") {
                if (!bossAoeEffects.some(aoe => aoe.id === id)) {
                    bossAoeEffects.push({ id, x: data.x, y: data.y, radius: data.radius, type: data.type, state: "warning" });
                }
            } else {
                const aoe = bossAoeEffects.find(effect => effect.id === id);
                if (aoe) {
                    aoe.state = "detonate";
                    setTimeout(() => { bossAoeEffects = bossAoeEffects.filter(effect => effect.id !== id); }, 200);
                }
            }
        }

        function handleTradeSync(data) {
            const snapshot = data.trade || data;
            if (snapshot.tradeId) activeTradeId = snapshot.tradeId;
            document.getElementById("trade-my-gold").value = Number.isFinite(Number(snapshot.myGold)) ? Number(snapshot.myGold) : 0;
            document.getElementById("trade-their-gold").innerText = "Gold: " + (Number.isFinite(Number(snapshot.theirGold)) ? Number(snapshot.theirGold) : 0);
            const renderOffer = offer => (Array.isArray(offer) ? offer : []).map(item => "<div style='font-size:11px'>" + escapeHtml(item) + "</div>").join("");
            document.getElementById("trade-my-offer").innerHTML = renderOffer(snapshot.myOffer);
            document.getElementById("trade-their-offer").innerHTML = renderOffer(snapshot.theirOffer);
            tradeLocked = Boolean(snapshot.bothLocked);
            const lockButton = document.getElementById("trade-lock-btn");
            const confirmButton = document.getElementById("trade-confirm-btn");
            if (lockButton) {
                lockButton.disabled = tradeLocked || Boolean(snapshot.myLocked);
                lockButton.innerText = tradeLocked ? "Both Locked" : "Lock Offer";
            }
            if (confirmButton) confirmButton.disabled = !tradeLocked;
        }

        function renderParty(data) {
            const members = Array.isArray(data.members) ? data.members : [];
            let html = "";
            if (pendingPartyInvite && members.length === 0) {
                html += "<div style='font-size:11px; margin-bottom:5px;'>" + escapeHtml(pendingPartyInvite.inviter) + " invited you.</div>" +
                    "<button onclick='acceptPartyInvite()' style='font-size:10px; margin-right:4px;'>Accept</button>" +
                    "<button onclick='declinePartyInvite()' style='font-size:10px;'>Decline</button>";
            }
            if (members.length > 0) {
                members.forEach(member => {
                    const name = typeof member === "string" ? member : (member.name || member.id || "Player");
                    const hp = typeof member === "string" ? 0 : Number(member.hp || 0);
                    const maxHp = typeof member === "string" ? 0 : Number(member.maxHp || 0);
                    html += "<div style='font-size:11px; margin-bottom:2px;'>" + escapeHtml(name) + (maxHp ? " (" + hp + "/" + maxHp + ")" : "") + "</div>";
                    if (maxHp > 0) html += "<div style='background:#444; width:100%; height:4px; margin-bottom:4px;'><div style='background:#e53935; width:" + Math.max(0, Math.min(100, hp / maxHp * 100)) + "%; height:100%;'></div></div>";
                });
                html += "<button onclick='leaveParty()' style='font-size:10px; margin-top:5px;'>Leave</button>";
            } else {
                html += "<em style='color:#666'>No Party</em>";
            }
            document.getElementById("party-list").innerHTML = html;
        }

        let pendingGuildInvite = null;
        function renderGuild(data) {
            const members = Array.isArray(data.members) ? data.members : [];
            let html = "";
            if (pendingGuildInvite && members.length === 0) {
                html += "<div style='font-size:11px; margin-bottom:5px;'>" + escapeHtml(pendingGuildInvite.inviter) + " invited you to <br><strong>" + escapeHtml(pendingGuildInvite.guildName) + "</strong></div>" +
                    "<button onclick='acceptGuildInvite()' style='font-size:10px; margin-right:4px;'>Accept</button>" +
                    "<button onclick='declineGuildInvite()' style='font-size:10px;'>Decline</button>";
            }
            if (members.length > 0) {
                html += "<div style='font-size:12px; color:#fbbf24; margin-bottom:4px;'><strong>" + escapeHtml(data.name || "") + "</strong></div>";
                members.forEach(member => {
                    html += "<div style='font-size:11px; margin-bottom:2px;'>" + escapeHtml(member) + "</div>";
                });
            } else if (!pendingGuildInvite) {
                html += "<em style='color:#666'>No Guild</em>";
            }
            document.getElementById("guild-list").innerHTML = html;
        }

        function acceptGuildInvite() {
            if (pendingGuildInvite && socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "chat", text: "/guild accept " + pendingGuildInvite.guildName, channel: "global" }));
                pendingGuildInvite = null;
                renderGuild({ members: [] });
            }
        }

        function declineGuildInvite() {
            pendingGuildInvite = null;
            renderGuild({ members: [] });
        }

        function renderShopSellList() {
            let sellHtml = "";
            let counts = {}; myInventoryData.forEach(i => counts[i] = (counts[i]||0)+1);
            for (let item in counts) {
                sellHtml += "<div style='display:flex; justify-content:space-between; margin-bottom:5px;'><span>" + escapeHtml(item) + " x" + counts[item] + "</span><button onclick='shopSell(\"" + escapeHtml(item) + "\")' style='background:#aa4444; border:none; color:white; padding:2px 5px; cursor:pointer'>Sell</button></div>";
            }
            if (myInventoryData.length === 0) sellHtml = "<em>Empty</em>";
            document.getElementById("shop-sell-list").innerHTML = sellHtml;
        }

        function closeShop() {
            document.getElementById("overlay").style.display = "none";
            document.getElementById("shop-modal").style.display = "none";
        }

        // === Crafting UI ===
        let craftRecipes = [];

        function renderCraftingList(recipes) {
            craftRecipes = Array.isArray(recipes) ? recipes : [];
            const list = document.getElementById("craft-list");
            if (craftRecipes.length === 0) {
                list.innerHTML = "<em style='color:#666'>No recipes known.</em>";
                return;
            }
            const html = craftRecipes.map(r => {
                const inputs = Object.entries(r.inputs || {}).map(([item, qty]) => {
                    const miss = (r.missing || []).find(m => m.item === item);
                    const color = miss ? '#f87171' : '#4ade80';
                    const detail = miss ? ` <span style="color:#64748b">(${miss.have}/${miss.required})</span>` : '';
                    return `<span style="color:${color}">${escapeHtml(item)} x${qty}${detail}</span>`;
                }).join(' <span style="color:#64748b">+</span> ');

                const disabled = r.canCraft ? '' : 'disabled';
                const opacity = r.canCraft ? '1' : '0.45';
                const status = r.canCraft
                    ? ''
                    : (r.locked ? `<div style="font-size:10px; color:#fbbf24; margin-top:2px;">Requires level ${escapeHtml(String(r.level))}</div>`
                                : `<div style="font-size:10px; color:#94a3b8; margin-top:2px;">Missing materials</div>`);

                return `<div style="background:rgba(15,23,42,0.5); border:1px solid rgba(255,255,255,0.06); border-radius:8px; padding:10px; margin-bottom:8px; opacity:${opacity}">
                    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
                        <div style="flex:1;">
                            <strong style="color:#e2e8f0; font-size:13px;">${escapeHtml(r.name)}${r.count > 1 ? ` <span style="color:#94a3b8;font-weight:400;">x${escapeHtml(String(r.count))}</span>` : ''}</strong>
                            <div style="font-size:11px; color:#94a3b8; margin-top:3px;">${inputs}</div>
                            <div style="font-size:11px; color:#64748b; margin-top:2px;">${escapeHtml(r.description || '')}</div>
                            ${status}
                        </div>
                        <button class="btn-spell" style="width:auto; margin:0; padding:8px 14px;" onclick="craftItem('${escapeHtml(r.id)}')" ${disabled}>Craft</button>
                    </div>
                </div>`;
            }).join('');
            list.innerHTML = html;
        }

        function openCrafting(data) {
            document.getElementById("overlay").style.display = "block";
            document.getElementById("craft-modal").style.display = "block";
            document.getElementById("craft-level").innerText = Number(data.level) || 1;
            renderCraftingList(data.recipes);
        }

        function closeCrafting() {
            document.getElementById("overlay").style.display = "none";
            document.getElementById("craft-modal").style.display = "none";
        }

        function craftItem(recipeId) {
            audio.coin();
            socket.send(JSON.stringify({ action: "craft_item", recipe_id: recipeId }));
        }


        // Browsers only allow audio to start from a user gesture, so the
        // context is created on the first interaction and the music begins
        // as soon as it is running.
        ["pointerdown", "keydown", "touchstart"].forEach(evt => {
            window.addEventListener(evt, () => {
                if (!audio.started) {
                    if (audio.init()) {
                        audio.startMusic();
                        addLog('🔊 Sound enabled');
                    }
                } else {
                    audio.resume();
                }
            }, { once: false });
        });


        function showNPCDialog(data) {
            activeNpcId = data.npc_id || null;
            activeDialogueNode = data.node_id || null;
            document.getElementById("overlay").style.display = "block";
            document.getElementById("npc-dialog").style.display = "block";
            document.getElementById("dialog-npc-name").innerText = data.npc_name;
            const content = document.getElementById("dialog-content");

            // Dialogue-tree shape: server-sent prose plus a list of choices.
            if (Array.isArray(data.choices)) {
                let html = "<p style='font-size:13px; line-height:1.5; margin-bottom:12px;'>" + escapeHtml(data.text || '') + "</p>";
                if (data.choices.length > 0) {
                    html += "<div style='display:flex; flex-direction:column; gap:6px;'>";
                    data.choices.forEach(choice => {
                        const next = choice.next ? escapeHtml(choice.next) : "";
                        const label = escapeHtml(choice.text || "");
                        html += "<button class='btn-dialogue' onclick='chooseDialogue(\"" + escapeHtml(data.node_id || "") + "\", \"" + escapeHtml(choice.id) + "\")'>" + label + "</button>";
                    });
                    html += "</div>";
                } else {
                    html += "<button class='btn-dialogue' onclick='closeNpcDialog()' style='background:#334155;'>End conversation</button>";
                }
                content.innerHTML = html;
                return;
            }

            // Legacy shape: a flat list of quests to accept.
            const quests = Array.isArray(data.quests) ? data.quests : [];
            let legacy = "<p>I have some tasks for you:</p>";
            quests.forEach(q => {
                legacy += "<div style='background:#2a2a2a; padding:10px; margin-bottom:5px; border-radius:5px;'><strong style='color:#ffcc44'>" + escapeHtml(q.name) + "</strong><br><span style='font-size:12px'>" + escapeHtml(q.description || q.desc || '') + "</span><br><button onclick='acceptQuest(\"" + escapeHtml(q.id) + "\")' style='margin-top:5px; background:#44aa44; color:white; border:none; padding:5px 10px; cursor:pointer'>Accept Quest</button></div>";
            });
            content.innerHTML = legacy;
        }

        function chooseDialogue(nodeId, choiceId) {
            if (!activeNpcId || !socket || socket.readyState !== 1) return;
            socket.send(JSON.stringify({
                action: "dialogue_choice",
                npc_id: activeNpcId,
                node_id: nodeId,
                choice_id: choiceId
            }));
        }

        function acceptQuest(qid) {
            socket.send(JSON.stringify({ action: "accept_quest", quest_id: qid, npc_id: activeNpcId }));
            closeNpcDialog();
        }
        function closeNpcDialog() {
            activeNpcId = null;
            document.getElementById("overlay").style.display = "none";
            document.getElementById("npc-dialog").style.display = "none";
        }
        function renderQuestJournal(data) {
            const ql = document.getElementById("quest-list");
            let html = "<div style=\"font-size:12px; margin-bottom:8px; color:#aaa\">Completed: " + data.completed_count + "</div>";
            if (!Array.isArray(data.quests) || data.quests.length === 0) { html += "<em style=\"color:#666;font-size:11px\">No active quests.</em>"; }
            else {
                data.quests.forEach(q => {
                    html += "<div style=\"background:#222; padding:5px; margin-bottom:5px; border-left:3px solid #ffcc44\"><strong style=\"font-size:13px\">" + escapeHtml(q.name) + "</strong>";
                    if (q.step) {
                        html += "<div style=\"font-size:10px; color:#fbbf24; margin-top:2px;\">Step " + (Number(q.step.index) + 1) + " of " + Number(q.step.count) + (q.step.awaiting_turn_in ? " &middot; return to the giver" : "") + "</div>";
                        if (q.step.text) html += "<div style=\"font-size:11px; color:#e2e8f0; font-style:italic; margin-top:2px;\">" + escapeHtml(q.step.text) + "</div>";
                    }
                    html += "<br>";
                    (Array.isArray(q.objectives) ? q.objectives : []).forEach(o => {
                        const done = o.done === true;
                        const tick = done ? "&#10003;" : "&#9675;";
                        html += "<div style=\"font-size:11px; color:" + (done ? "#44ff44" : "#ccc") + "\">" + tick + " " + escapeHtml(o.text || "") + " " + escapeHtml(String(o.progress || "")) + "</div>";
                    });
                    html += "</div>";
                });
            }
            ql.innerHTML = html;
        }

        let bankState = { gold: 0, items: [] };

        function openBank(data) {
            document.getElementById("overlay").style.display = "block";
            document.getElementById("bank-modal").style.display = "block";
            renderBank(data);
        }

        function closeBank() {
            document.getElementById("overlay").style.display = "none";
            document.getElementById("bank-modal").style.display = "none";
            document.getElementById("bank-gold-input").value = "";
        }

        function renderBank(data) {
            if (data) bankState = data;
            document.getElementById("bank-wallet-gold").innerText = myGold;
            document.getElementById("bank-stored-gold").innerText = bankState.gold || 0;
            document.getElementById("bank-vault-count").innerText = (bankState.items || []).length;
            
            let invHtml = "";
            let counts = {}; myInventoryData.forEach(i => counts[i] = (counts[i]||0)+1);
            for (let item in counts) {
                invHtml += `<div style='display:flex; justify-content:space-between; margin-bottom:5px; font-size:12px;'><span>${escapeHtml(item)} x${counts[item]}</span><button onclick='depositItem("${escapeHtml(item)}")' style='background:#10b981; border:none; color:white; padding:2px 5px; cursor:pointer; border-radius:3px;'>Deposit</button></div>`;
            }
            if (myInventoryData.length === 0) invHtml = "<em style='color:#666'>Empty</em>";
            document.getElementById("bank-inv-list").innerHTML = invHtml;

            let vaultHtml = "";
            let vcounts = {}; (bankState.items || []).forEach(i => vcounts[i] = (vcounts[i]||0)+1);
            for (let item in vcounts) {
                vaultHtml += `<div style='display:flex; justify-content:space-between; margin-bottom:5px; font-size:12px;'><span>${escapeHtml(item)} x${vcounts[item]}</span><button onclick='withdrawItem("${escapeHtml(item)}")' style='background:#ef4444; border:none; color:white; padding:2px 5px; cursor:pointer; border-radius:3px;'>Withdraw</button></div>`;
            }
            if ((bankState.items || []).length === 0) vaultHtml = "<em style='color:#666'>Empty</em>";
            document.getElementById("bank-vault-list").innerHTML = vaultHtml;
        }

        function depositGold() {
            const amt = parseInt(document.getElementById("bank-gold-input").value);
            if (amt > 0 && socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "bank_deposit_gold", amount: amt }));
                document.getElementById("bank-gold-input").value = "";
            }
        }

        function withdrawGold() {
            const amt = parseInt(document.getElementById("bank-gold-input").value);
            if (amt > 0 && socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "bank_withdraw_gold", amount: amt }));
                document.getElementById("bank-gold-input").value = "";
            }
        }

        function depositItem(item) {
            if (socket && socket.readyState === 1) socket.send(JSON.stringify({ action: "bank_deposit_item", item: item }));
        }

        function withdrawItem(item) {
            if (socket && socket.readyState === 1) socket.send(JSON.stringify({ action: "bank_withdraw_item", item: item }));
        }

        window.dragStart = function(ev, item) {
            ev.dataTransfer.setData("text/plain", item);
        };

        window.toggleMinimap = function() {
            const mc = document.getElementById("minimap-container");
            if (mc) mc.style.display = (mc.style.display === "none") ? "block" : "none";
        };

        window.dropTradeItem = function(ev) {
            ev.preventDefault();
            const item = ev.dataTransfer.getData("text/plain");
            if (item && socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "trade_add_item", item: item }));
            }
        };

        window.dropBankItem = function(ev) {
            ev.preventDefault();
            const item = ev.dataTransfer.getData("text/plain");
            if (item && socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "bank_deposit_item", item: item }));
            }
        };

        window.dropOnGround = function(ev) {
            ev.preventDefault();
            const item = ev.dataTransfer.getData("text/plain");
            if (item && socket && socket.readyState === 1) {
                // When OpenCode creates the drop_item handler, this will send the dragged item
                // to be spawned on the ground at the player's current coordinates.
                socket.send(JSON.stringify({ action: "drop_item", item: item }));
            }
        };

        function openGuildModal() {
            document.getElementById("overlay").style.display = "block";
            document.getElementById("guild-modal").style.display = "block";
            if (player && player.guild) {
                document.getElementById("guild-create-section").style.display = "none";
                document.getElementById("guild-manage-section").style.display = "block";
                document.getElementById("guild-manage-name").innerText = player.guild;
            } else {
                document.getElementById("guild-create-section").style.display = "block";
                document.getElementById("guild-manage-section").style.display = "none";
            }
        }

        function closeGuildModal() {
            document.getElementById("overlay").style.display = "none";
            document.getElementById("guild-modal").style.display = "none";
        }

        function createGuild() {
            const nameInput = document.getElementById("guild-name-input");
            const name = nameInput.value.trim();
            if (!name) return;
            if (socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "chat", text: "/guild create " + name, channel: "global" }));
                nameInput.value = "";
                closeGuildModal();
            }
        }

        function inviteToGuild() {
            const inviteInput = document.getElementById("guild-invite-input");
            const target = inviteInput.value.trim();
            if (!target) return;
            if (socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "chat", text: "/guild invite " + target, channel: "global" }));
                inviteInput.value = "";
                closeGuildModal();
            }
        }

        function leaveGuild() {
            if (socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "chat", text: "/guild leave", channel: "global" }));
                closeGuildModal();
            }
        }

        window.openAuctionModal = function() {
            document.getElementById("overlay").style.display = "block";
            document.getElementById("auction-modal").style.display = "block";
            if (socket && socket.readyState === 1) socket.send(JSON.stringify({ action: "auction_request" }));
        };

        window.closeAuctionModal = function() {
            document.getElementById("overlay").style.display = "none";
            document.getElementById("auction-modal").style.display = "none";
        };

        window.sellAuction = function() {
            const item = document.getElementById("auction-item-name").value;
            const price = parseInt(document.getElementById("auction-item-price").value, 10);
            if (!item || isNaN(price) || price <= 0) return alert("Invalid item or price!");
            if (socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "auction_list", item: item, price: price }));
                document.getElementById("auction-item-name").value = "";
                document.getElementById("auction-item-price").value = "";
            }
        };

        window.buyAuction = function(id) {
            if (socket && socket.readyState === 1) {
                socket.send(JSON.stringify({ action: "auction_buy", id: id }));
            }
        };

        window.renderAuctionUI = function() {
            const listDiv = document.getElementById("auction-list");
            if (!listDiv) return;
            if (!window.auctionItems || window.auctionItems.length === 0) {
                listDiv.innerHTML = "<em style='color:#aaa'>The auction house is empty.</em>";
                return;
            }
            let html = "";
            window.auctionItems.forEach(item => {
                html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#222; padding:5px; margin-bottom:5px; border-radius:3px;">
                    <div><span style="color:#fbbf24">${item.item}</span> <span style="color:#aaa; font-size:12px;">(Seller: ${item.sellerName})</span></div>
                    <div>
                        <span style="color:gold; margin-right: 10px;">${item.price}G</span>
                        <button onclick="window.buyAuction('${item.id}')" style="background:#3b82f6; color:white; border:none; padding:4px 8px; cursor:pointer;">Buy</button>
                    </div>
                </div>`;
            });
            listDiv.innerHTML = html;
        };
