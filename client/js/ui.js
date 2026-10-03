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

            setVolume(val) {
                if (this.master && !this.muted) {
                    const now = this.ctx.currentTime;
                    this.master.gain.cancelScheduledValues(now);
                    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, val)), now, 0.02);
                }
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

            fireball() {
                if (!this.throttled('fireball', 90)) return;
                this.noise({ duration: 0.4, gain: 0.3, filter: 400, type: 'lowpass' });
                this.tone({ freq: 300, slideTo: 50, type: 'sawtooth', duration: 0.3, gain: 0.15 });
            }

            heal() {
                if (!this.throttled('heal', 90)) return;
                this.tone({ freq: 400, slideTo: 800, type: 'sine', duration: 0.4, gain: 0.15 });
                this.tone({ freq: 600, slideTo: 1200, type: 'sine', duration: 0.5, gain: 0.1, delay: 0.1 });
            }

            freeze() {
                if (!this.throttled('freeze', 90)) return;
                this.noise({ duration: 0.3, gain: 0.2, filter: 3000, type: 'highpass' });
                this.tone({ freq: 1200, slideTo: 800, type: 'triangle', duration: 0.2, gain: 0.1 });
            }

            shoot() {
                if (!this.throttled('shoot', 90)) return;
                this.noise({ duration: 0.1, gain: 0.2, filter: 2000, type: 'highpass' });
                this.tone({ freq: 600, slideTo: 200, type: 'triangle', duration: 0.1, gain: 0.1 });
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
            startMusic(biome = "city") {
                if (!this.started || this.musicTimer) return;
                this.currentBiome = biome;
                let bass = [110, 130.81, 98, 146.83];
                let arp = [440, 523.25, 659.25, 523.25, 587.33, 440, 659.25, 523.25];
                let ms = 420;
                
                if (biome === "snow") {
                    bass = [130.81, 155.56, 116.54, 174.61];
                    arp = [523.25, 622.25, 783.99, 622.25, 698.46, 523.25, 783.99, 622.25];
                    ms = 480;
                } else if (biome === "desert") {
                    bass = [98, 110, 92.50, 123.47];
                    arp = [392, 493.88, 587.33, 493.88, 554.37, 392, 587.33, 493.88];
                    ms = 400;
                } else if (biome === "swamp") {
                    bass = [82.41, 98, 73.42, 110];
                    arp = [329.63, 392, 493.88, 392, 440, 329.63, 493.88, 392];
                    ms = 500;
                }

                this.musicTimer = setInterval(() => {
                    if (!this.started || this.muted || !this.ctx || this.ctx.state !== 'running') return;
                    const bar = Math.floor(this.step / 8) % bass.length;
                    this.tone({ freq: bass[bar], type: 'sine', duration: 1.6, gain: 0.22, dest: this.musicGain, attack: 0.35 });
                    const note = arp[this.step % arp.length];
                    this.tone({ freq: note, type: 'triangle', duration: 0.5, gain: 0.08, dest: this.musicGain, delay: 0.02 });
                    this.step++;
                }, ms);
            }

            changeMusic(biome) {
                if (this.currentBiome === biome) return;
                this.stopMusic();
                this.startMusic(biome);
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

        /*
         * Escapes a string for literal use inside a RegExp.
         *
         * The mention highlight builds its pattern from the player's own name, so
         * without this a name is a pattern rather than a word. A name is currently
         * limited to [A-Za-z][A-Za-z0-9 _-]* by the server, which contains nothing
         * a RegExp treats specially except '-', so this is not currently
         * reachable. It is here because that limit lives on the server, the name
         * is echoed back to every client on the floor, and the day the charset is
         * widened this silently becomes a name that matches the wrong message --
         * or none. Cheaper than debugging that later.
         */
        function escapeRegExp(value) {
            return String(value ?? "").replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");
        }

        let chatMessages = [];
        let activeChatTab = "all";
        window.chatFilterSetting = "all";
        window.particleSetting = true;

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
                if (window.chatFilterSetting === "none" && msg.channel !== "system") return;
                if (window.chatFilterSetting === "local" && msg.channel === "global") return;
                
                if (activeChatTab === "all" || msg.channel === activeChatTab || (activeChatTab==="system" && msg.channel==="system")) {
                    const d = document.createElement("div");

                    // Everything below goes into innerHTML, because the timestamp
                    // and the mention highlight are real elements. That makes the
                    // escaping load-bearing rather than precautionary, so all three
                    // dynamic values go through the file's own escapeHtml --
                    // including quotes, which a hand-rolled &/<//> replacement
                    // would have let through.
                    let myName = window.myName;
                    let escapedMsg = escapeHtml(msg.text);

                    // Mention highlighting. The name is escaped before it reaches
                    // the markup, and the pattern is built with a literal match so
                    // a name is matched as typed rather than interpreted as a
                    // pattern -- without it, a name containing a metacharacter
                    // would either match the wrong text or match nothing at all.
                    if (myName && escapedMsg.includes("@" + myName)) {
                        // Anchored with a negative lookahead rather than \b. \b is a
                        // *word* boundary, so a name ending in a non-word character
                        // never matches: the pattern ends on "-", the message has a
                        // space next, and there is no boundary between two non-word
                        // characters. "B-" is a legal name under the server charset
                        // [A-Za-z][A-Za-z0-9 _-]*, so its mentions would silently
                        // never light up. This asks the question that was meant:
                        // "is the next character another word character?"
                        escapedMsg = escapedMsg.replace(
                            new RegExp(escapeRegExp("@" + myName) + "(?![A-Za-z0-9_])", "g"),
                            `<span style="background:rgba(251,191,36,0.3); color:#fbbf24; padding:0 4px; border-radius:3px; font-weight:bold;">@${escapeHtml(myName)}</span>`
                        );
                    }

                    let timeSpan = msg.time ? `<span style="color:#64748b; font-size:10px; margin-right:4px;">[${escapeHtml(msg.time)}]</span>` : "";

                    d.innerHTML = timeSpan + escapedMsg;
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
            else if(channel === "whisper" || msg.startsWith("[Whisper]")) { color = "#d946ef"; channel = "whisper"; }
            else if(channel === "global") { color = "#ffffff"; }
            let timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            chatMessages.push({ text: msg, channel: channel, color: color, time: timeStr });
            if (chatMessages.length > 100) chatMessages.shift();
            renderChat();

            if (msg.includes("Quest completed:")) {
                const questName = msg.split("Quest completed:")[1].trim();
                const qc = document.getElementById("quest-celebration");
                const qcN = document.getElementById("quest-celebration-name");
                if (qc && qcN) {
                    qcN.innerText = questName;
                    qc.style.opacity = 1;
                    qc.style.transform = "translate(-50%, -50%) scale(1)";
                    setTimeout(() => {
                        qc.style.opacity = 0;
                        qc.style.transform = "translate(-50%, -50%) scale(0.5)";
                    }, 4000);
                }
            }
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
                sellHtml += "<div style='display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2); padding:6px 10px; border-radius:4px; border:1px solid rgba(255,255,255,0.05);'><span>" + escapeHtml(item) + " <span style='color:#94a3b8; font-size:11px'>x" + counts[item] + "</span></span><button onclick='shopSell(\"" + escapeHtml(item) + "\")' style='background:#ef4444; border:none; color:white; padding:4px 8px; border-radius:4px; font-weight:bold; cursor:pointer; font-size:12px; transition:background 0.2s;' onmouseover='this.style.background=\"#dc2626\"' onmouseout='this.style.background=\"#ef4444\"'>Sell</button></div>";
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
            
            const portraitCanvas = document.getElementById("dialog-npc-portrait");
            if (portraitCanvas && window.getSprite) {
                const ctx = portraitCanvas.getContext("2d");
                ctx.clearRect(0, 0, 32, 32);
                let spriteKey = "npc";
                if (data.npc_name.includes("Aria")) spriteKey = "npc_aria";
                else if (data.npc_name.includes("Merchant")) spriteKey = "merchant";
                else if (data.npc_name.includes("Banker")) spriteKey = "banker";
                else if (data.npc_name.includes("Arthur")) spriteKey = "king_arthur";
                
                const sprite = window.getSprite(spriteKey);
                if (sprite) {
                    ctx.drawImage(sprite, 0, 0, 32, 32);
                }
            }

            const content = document.getElementById("dialog-content");

            // Dialogue-tree shape: server-sent prose plus a list of choices.
            if (Array.isArray(data.choices)) {
                let html = "<p style='font-size:15px; line-height:1.6; margin-bottom:16px; color:#e2e8f0;'>" + escapeHtml(data.text || '') + "</p>";
                if (data.choices.length > 0) {
                    html += "<div style='display:flex; flex-direction:column; gap:8px;'>";
                    data.choices.forEach(choice => {
                        const next = choice.next ? escapeHtml(choice.next) : "";
                        const label = escapeHtml(choice.text || "");
                        html += "<button class='btn-dialogue' onclick='chooseDialogue(\"" + escapeHtml(data.node_id || "") + "\", \"" + escapeHtml(choice.id) + "\")' style='padding:10px 15px; text-align:left; background:rgba(30,41,59,0.8); border:1px solid #475569; color:#f8fafc; border-radius:6px; cursor:pointer; font-size:14px; transition:all 0.2s;' onmouseover='this.style.background=\"#334155\"; this.style.borderColor=\"#fbbf24\";' onmouseout='this.style.background=\"rgba(30,41,59,0.8)\"; this.style.borderColor=\"#475569\";'>" + label + "</button>";
                    });
                    html += "</div>";
                } else {
                    html += "<button class='btn-dialogue' onclick='closeNpcDialog()' style='padding:10px 15px; text-align:center; background:#475569; border:none; color:white; border-radius:6px; cursor:pointer; font-weight:bold; width:100%; transition:background 0.2s;' onmouseover='this.style.background=\"#ef4444\"' onmouseout='this.style.background=\"#475569\"'>Farewell</button>";
                }
                content.innerHTML = html;
                return;
            }

            // Legacy shape: a flat list of quests to accept.
            const quests = Array.isArray(data.quests) ? data.quests : [];
            let legacy = "<p style='font-size:15px; color:#e2e8f0; margin-bottom:16px;'>I have some tasks for you:</p>";
            if (quests.length === 0) legacy += "<em style='color:#94a3b8'>No quests available right now.</em>";
            quests.forEach(q => {
                legacy += "<div style='background:rgba(0,0,0,0.3); padding:12px; margin-bottom:8px; border-radius:6px; border:1px solid #334155;'><strong style='color:#fbbf24; font-size:16px;'>" + escapeHtml(q.name) + "</strong><br><p style='font-size:13px; color:#cbd5e1; margin:6px 0; line-height:1.4;'>" + escapeHtml(q.description || q.desc || '') + "</p><button onclick='acceptQuest(\"" + escapeHtml(q.id) + "\")' style='margin-top:5px; background:#10b981; color:white; font-weight:bold; border:none; padding:8px 12px; border-radius:4px; cursor:pointer; transition:background 0.2s;' onmouseover='this.style.background=\"#059669\"' onmouseout='this.style.background=\"#10b981\"'>Accept Quest</button></div>";
            });
            legacy += "<button onclick='closeNpcDialog()' style='margin-top:10px; padding:10px 15px; text-align:center; background:#475569; border:none; color:white; border-radius:6px; cursor:pointer; font-weight:bold; width:100%; transition:background 0.2s;' onmouseover='this.style.background=\"#ef4444\"' onmouseout='this.style.background=\"#475569\"'>Close</button>";
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
            let html = "<div style=\"font-size:12px; margin-bottom:12px; color:#cbd5e1; font-weight:bold; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:6px;\">COMPLETED: <span style=\"color:#fbbf24;\">" + data.completed_count + "</span></div>";
            if (!Array.isArray(data.quests) || data.quests.length === 0) { html += "<div style=\"color:#64748b; font-size:12px; text-align:center; padding:15px; font-style:italic;\">No active quests.</div>"; }
            else {
                data.quests.forEach(q => {
                    html += "<div style=\"background:rgba(30,41,59,0.7); padding:12px; margin-bottom:8px; border-radius:6px; border-left:3px solid #fbbf24; box-shadow:0 2px 4px rgba(0,0,0,0.2);\"><strong style=\"font-size:14px; color:#f8fafc;\">" + escapeHtml(q.name) + "</strong>";
                    if (q.step) {
                        html += "<div style=\"font-size:11px; color:#fbbf24; margin-top:4px; font-weight:bold;\">Step " + (Number(q.step.index) + 1) + " of " + Number(q.step.count) + (q.step.awaiting_turn_in ? " &middot; <span style='color:#10b981'>Return to NPC</span>" : "") + "</div>";
                        if (q.step.text) html += "<div style=\"font-size:12px; color:#94a3b8; font-style:italic; margin-top:4px; line-height:1.4;\">\"" + escapeHtml(q.step.text) + "\"</div>";
                    }
                    html += "<div style=\"margin-top:8px; padding-top:8px; border-top:1px dashed rgba(255,255,255,0.1);\">";
                    (Array.isArray(q.objectives) ? q.objectives : []).forEach(o => {
                        const done = o.done === true;
                        const tick = done ? "<span style='color:#10b981'>✓</span>" : "<span style='color:#64748b'>○</span>";
                        html += "<div style=\"font-size:12px; color:" + (done ? "#10b981" : "#e2e8f0") + "; margin-bottom:2px; display:flex; gap:6px;\">" + tick + " <span>" + escapeHtml(o.text || "") + " <strong style='color:#cbd5e1'>" + escapeHtml(String(o.progress || "")) + "</strong></span></div>";
                    });
                    html += "</div></div>";
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

        window.guildBankDeposit = function() {
            const amt = parseInt(document.getElementById("guild-bank-amt").value);
            if (!amt || amt <= 0) return;
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ action: "guild_bank_deposit", amount: amt }));
            }
            document.getElementById("guild-bank-amt").value = "";
        };

        window.guildBankWithdraw = function() {
            const amt = parseInt(document.getElementById("guild-bank-amt").value);
            if (!amt || amt <= 0) return;
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ action: "guild_bank_withdraw", amount: amt }));
            }
            document.getElementById("guild-bank-amt").value = "";
        };

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
                // Everything here came off the wire and is escaped before it
                // becomes markup. sellerName in particular is the seller's
                // chosen character name, and character names are only checked
                // for being a non-empty string -- nothing stops one containing
                // markup. Unescaped, listing an item executed script in every
                // other player's browser when they opened this panel, which is
                // a stored XSS reachable by anyone who can make a character.
                //
                // price is coerced rather than escaped: it is a count of gold,
                // and Number() drops anything that is not one instead of
                // rendering it.
                html += `<div style="display:flex; justify-content:space-between; align-items:center; background:#222; padding:5px; margin-bottom:5px; border-radius:3px;">
                    <div><span style="color:#fbbf24">${escapeHtml(item.item)}</span> <span style="color:#aaa; font-size:12px;">(Seller: ${escapeHtml(item.sellerName)})</span></div>
                    <div>
                        <span style="color:gold; margin-right: 10px;">${Number(item.price) || 0}G</span>
                        <button onclick="window.buyAuction('${escapeHtml(item.id)}')" style="background:#3b82f6; color:white; border:none; padding:4px 8px; cursor:pointer;">Buy</button>
                    </div>
                </div>`;
            });
            listDiv.innerHTML = html;
        };

        // === Custom Tooltip ===
        window.showTooltip = function(e, title, content, clickNote) {
            const tt = document.getElementById("custom-tooltip");
            if (!tt) return;
            let html = "<div class='tooltip-title'>" + escapeHtml(title) + "</div>";
            if (content) html += "<div style='margin-bottom: 4px;'>" + escapeHtml(content) + "</div>";
            if (clickNote) html += "<em style='color:#64748b; font-size: 10px;'>" + escapeHtml(clickNote) + "</em>";
            tt.innerHTML = html;
            tt.style.display = "block";
            window.moveTooltip(e);
        };

        window.hideTooltip = function() {
            const tt = document.getElementById("custom-tooltip");
            if (tt) tt.style.display = "none";
        };

        window.moveTooltip = function(e) {
            const tt = document.getElementById("custom-tooltip");
            if (!tt || tt.style.display === "none") return;
            let x = e.pageX + 15;
            let y = e.pageY + 15;
            
            // Keep on screen
            const rect = tt.getBoundingClientRect();
            if (x + rect.width > window.innerWidth) x = e.pageX - rect.width - 10;
            if (y + rect.height > window.innerHeight) y = e.pageY - rect.height - 10;
            
            tt.style.left = x + "px";
            tt.style.top = y + "px";
        };

        // === Level Up Celebration ===
        window.showLevelUpCelebration = function(newLevel) {
            const cel = document.getElementById("levelup-celebration");
            if (!cel) return;
            document.getElementById("levelup-text").innerText = "You reached Level " + newLevel;
            
            // Trigger animation
            cel.style.opacity = "1";
            cel.style.transform = "translate(-50%, -50%) scale(1.2)";
            
            // Add some particle flash overlay
            const flash = document.createElement("div");
            flash.style.position = "fixed";
            flash.style.top = "0"; flash.style.left = "0";
            flash.style.width = "100%"; flash.style.height = "100%";
            flash.style.backgroundColor = "rgba(251, 191, 36, 0.3)";
            flash.style.pointerEvents = "none";
            flash.style.zIndex = "4999";
            flash.style.transition = "opacity 1s ease-out";
            document.body.appendChild(flash);
            
            // Fade out
            setTimeout(() => {
                cel.style.opacity = "0";
                cel.style.transform = "translate(-50%, -50%) scale(1.5)";
                flash.style.opacity = "0";
            }, 2500);
            
            setTimeout(() => {
                cel.style.transform = "translate(-50%, -50%) scale(0.5)"; // reset
                flash.remove();
            }, 3500);
        };

        // === World Map ===
        window.openWorldMap = function() {
            document.getElementById("overlay").style.display = "block";
            const m = document.getElementById("world-map-modal");
            m.style.display = "block";
            m.classList.add("active");
            
            if (window.player) {
                const dot = document.getElementById("map-player-dot");
                dot.style.left = (window.player.x / 8) + "px";
                dot.style.top = (window.player.y / 8) + "px";
            }
        };

        window.closeWorldMap = function() {
            const m = document.getElementById("world-map-modal");
            m.style.display = "none";
            m.classList.remove("active");
            document.getElementById("overlay").style.display = "none";
        };

        // === Friends ===
        window.openFriendsModal = function() {
            document.getElementById("overlay").style.display = "block";
            const m = document.getElementById("friends-modal");
            m.style.display = "block";
            m.classList.add("active");
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ action: "friend_list_request" }));
            }
        };

        window.addFriend = function() {
            const nameInput = document.getElementById("friend-add-input");
            const friendName = nameInput.value.trim();
            if (!friendName) return;
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ action: "friend_add", name: friendName }));
            }
            nameInput.value = "";
        };

        window.removeFriend = function(friendName) {
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ action: "friend_remove", name: friendName }));
            }
        };

        window.inspectTarget = function() {
            if (!window.currentTargetId) return;
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ action: "inspect_player", id: window.currentTargetId }));
            }
        };

        window.toggleEmoteMenu = function() {
            const menu = document.getElementById("emote-menu");
            menu.style.display = menu.style.display === "none" ? "flex" : "none";
        };

        window.sendEmote = function(emoji) {
            document.getElementById("emote-menu").style.display = "none";
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ action: "emote", text: emoji }));
            }
        };

        window.openLeaderboardModal = function() {
            document.getElementById("overlay").style.display = "block";
            const m = document.getElementById("leaderboard-modal");
            m.style.display = "block";
            m.classList.add("active");
            document.getElementById("leaderboard-ui-list").innerHTML = "<em style='color:#666'>Loading rankings...</em>";
            if (window.ws && window.ws.readyState === WebSocket.OPEN) {
                window.ws.send(JSON.stringify({ action: "leaderboard_request" }));
            }
        };

        // === Settings ===
        window.openSettingsModal = function() {
            document.getElementById("overlay").style.display = "block";
            const m = document.getElementById("settings-modal");
            m.style.display = "block";
            m.classList.add("active");
        };

        window.updateVolumeSetting = function() {
            const v = document.getElementById("setting-volume").value;
            document.getElementById("volume-val-display").innerText = v;
            if (window.audio && window.audio.setVolume) window.audio.setVolume(v / 100);
        };

        window.saveSettings = function() {
            window.chatFilterSetting = document.getElementById("setting-chat-filter").value;
            window.particleSetting = document.getElementById("setting-particles").checked;
            
            const m = document.getElementById("settings-modal");
            m.style.display = "none";
            m.classList.remove("active");
            document.getElementById("overlay").style.display = "none";
            
            renderChat(); // Re-render chat based on new filter
        };

