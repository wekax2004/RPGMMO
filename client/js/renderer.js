        // Sprite loading is best-effort. A sprite only becomes drawable once
        // the image has actually decoded, so a missing or unreadable asset
        // falls back to the emoji renderer instead of throwing inside draw().
        const SPRITE_BASE = "/assets/";
        const SPRITE_FILES = {
            warrior: "warrior.png",
            mage: "mage.png",
            ranger: "ranger.png",
            healer: "healer.png",
            spider: "spider.png",
            skeleton: "skeleton.png",
            goblin: "goblin.png",
            yeti: "yeti.png",
            dragon: "dragon.png"
        };
        const loadedSprites = {};
        Object.keys(SPRITE_FILES).forEach(key => {
            const img = new Image();
            const entry = { image: img, ready: false };
            loadedSprites[key] = entry;
            img.onload = () => { entry.ready = true; };
            img.onerror = () => { entry.ready = false; };
            img.src = SPRITE_BASE + SPRITE_FILES[key];
        });
        function getSprite(key) {
            const entry = loadedSprites[key];
            return entry && entry.ready ? entry.image : null;
        }

        function draw() {
            cameraX = player.x - SCREEN_W / 2 + 16;
            cameraY = player.y - SCREEN_H / 2 + 16;
            cameraX = Math.max(0, Math.min(cameraX, MAP_W - SCREEN_W));
            cameraY = Math.max(0, Math.min(cameraY, MAP_H - SCREEN_H));

            ctx.fillStyle = "#111"; ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
            ctx.save();
            ctx.translate(-cameraX, -cameraY);

            // Background color base
            ctx.fillStyle = "#1e1e2f"; ctx.fillRect(0, 0, MAP_W, MAP_H);
            
            // Draw regions
            ctx.fillStyle = "#2c4021"; ctx.fillRect(800, 0, 1200, 1200); // Forest
            ctx.fillStyle = "#6b5b40"; ctx.fillRect(2000, 0, 1200, 1600); // Eastern Ruins
            ctx.fillStyle = "#2a3b32"; ctx.fillRect(0, 800, 1600, 1000); // Swamp
            ctx.fillStyle = "#e0f7fa"; ctx.fillRect(1600, 1600, 1600, 1000); // Snow Mountain
            ctx.fillStyle = "#d4b872"; ctx.fillRect(0, 1800, 1600, 1400); // Desert
            ctx.fillStyle = "#111118"; ctx.fillRect(1600, 2600, 1600, 600); // Crypt
            
            // City safe zone
            ctx.fillStyle = "#4a5d4e"; ctx.fillRect(0, 0, 800, 800); // City base
            ctx.fillStyle = "rgba(0, 255, 100, 0.15)"; ctx.fillRect(0, 0, 640, 640); // Safe zone aura

            ctx.strokeStyle = "rgba(0,0,0,0.1)";
            for (let x = 0; x <= MAP_W; x += 32) {
                if (x >= cameraX && x <= cameraX + SCREEN_W) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, MAP_H); ctx.stroke(); }
            }
            for (let y = 0; y <= MAP_H; y += 32) {
                if (y >= cameraY && y <= cameraY + SCREEN_H) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(MAP_W, y); ctx.stroke(); }
            }

            obstacles.forEach(obs => {
                if (obs.x < cameraX - 32 || obs.x > cameraX + SCREEN_W || obs.y < cameraY - 32 || obs.y > cameraY + SCREEN_H) return;
                if (obs.type === "tree") { ctx.fillStyle = "#1b3e15"; ctx.fillRect(obs.x, obs.y, 32, 32); } 
                else if (obs.type === "rock") { ctx.fillStyle = "#757575"; ctx.beginPath(); ctx.arc(obs.x + 16, obs.y + 16, 14, 0, Math.PI*2); ctx.fill(); } 
                else if (obs.type === "wall") { ctx.fillStyle = "#222"; ctx.fillRect(obs.x, obs.y, 32, 32); }
                else if (obs.type === "ruin_wall") { ctx.fillStyle = "#4a4a40"; ctx.fillRect(obs.x, obs.y, 32, 32); }
                else if (obs.type === "water") { ctx.fillStyle = "rgba(40, 150, 120, 0.7)"; ctx.fillRect(obs.x, obs.y, 32, 32); }
                else if (obs.type === "cactus") { ctx.fillStyle = "#2b6b25"; ctx.fillRect(obs.x + 8, obs.y + 4, 16, 24); }
                else if (obs.type === "gravestone") { ctx.fillStyle = "#555"; ctx.beginPath(); ctx.arc(obs.x + 16, obs.y + 12, 10, 0, Math.PI, true); ctx.fillRect(obs.x + 6, obs.y + 12, 20, 16); ctx.fill(); }
            });

            for (let id in gatherNodes) {
                let n = gatherNodes[id];
                ctx.fillStyle = n.color; ctx.beginPath(); ctx.arc(n.x + 16, n.y + 16, 10, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = "#000"; ctx.font = "10px Arial"; ctx.fillText(n.symbol, n.x + 12, n.y + 20);
            }
            for (let id in clientCorpses) {
                let corpse = clientCorpses[id];
                ctx.font = "24px Arial"; ctx.fillText("☠️", corpse.x + 4, corpse.y + 24);
            }
            for (let id in chests) {
                let c = chests[id];
                ctx.font = "24px Arial"; ctx.fillText("🎁", c.x + 4, c.y + 24);
            }
            for (let id in npcsLocal) {
                let npc = npcsLocal[id];
                const isBench = npc.name === "Workbench";
                if (isBench) {
                    ctx.fillStyle = "#8a5a2b";
                    ctx.fillRect(npc.x + 2, npc.y + 10, 28, 18);
                    ctx.fillStyle = "#c98f4e";
                    ctx.fillRect(npc.x + 2, npc.y + 10, 28, 4);
                    ctx.fillStyle = "#fbbf24";
                    ctx.fillRect(npc.x + 8, npc.y + 18, 4, 4);
                    ctx.fillRect(npc.x + 20, npc.y + 18, 4, 4);
                } else {
                    ctx.font = "28px Arial"; ctx.fillText("🧙‍♂️", npc.x + 2, npc.y + 26);
                }
                ctx.fillStyle = "#fff"; ctx.font = "bold 12px 'Inter', sans-serif"; ctx.fillText(npc.name, npc.x - 4, npc.y - 8);
                if (!isBench) { ctx.fillStyle = "#fbbf24"; ctx.fillText("!", npc.x + 12, npc.y - 22); }
            }

            for (let id in mobs) {
                let m = mobs[id];
                if (m.renderX === undefined) { m.renderX = m.x; m.renderY = m.y; }
                m.renderX += (m.x - m.renderX) * 0.2;
                m.renderY += (m.y - m.renderY) * 0.2;
                let isBoss = m.isBoss;
                let size = isBoss ? 48 : 32;
                let drawX = m.renderX - (size - 32)/2;
                let drawY = m.renderY - (size - 32)/2;

                if (m.isElite) { ctx.fillStyle = "rgba(255,0,0,0.2)"; ctx.beginPath(); ctx.arc(m.renderX + 16, m.renderY + 16, 20, 0, Math.PI*2); ctx.fill(); }
                if (isBoss) { 
                    const isEnraged = m.phase === 2;
                    ctx.fillStyle = isEnraged ? "rgba(255,100,0,0.3)" : "rgba(128,0,128,0.2)"; 
                    ctx.beginPath(); ctx.arc(m.renderX + 16, m.renderY + 16, 32, 0, Math.PI*2); ctx.fill(); 
                    if (isEnraged) {
                        ctx.fillStyle = "#ef4444";
                        ctx.font = "bold 14px 'Inter'";
                        ctx.fillText("ENRAGED", drawX - 10, drawY - 25);
                    }
                }

                // Map missing monsters to existing sprites temporarily
                let spriteKey = m.type;
                if (spriteKey === "minotaur") spriteKey = "goblin";
                if (spriteKey === "bear") spriteKey = "yeti";
                
                const mobSprite = getSprite(spriteKey);
                if (mobSprite) {
                    // Draw the image instead of an emoji
                    // Increase size if it's a boss
                    const renderSize = isBoss ? size * 1.5 : 32;
                    const offset = isBoss ? (renderSize - size) / 2 : 0;
                    ctx.drawImage(mobSprite, drawX - offset, drawY - offset, renderSize, renderSize);
                } else {
                    // Fallback just in case
                    ctx.font = isBoss ? "40px Arial" : "28px Arial";
                    ctx.fillText("👾", drawX, drawY + size - 4);
                }
                ctx.fillStyle = "red"; ctx.fillRect(drawX, drawY - 8, size, 4);
                ctx.fillStyle = "#00ff00"; ctx.fillRect(drawX, drawY - 8, size * (m.hp / m.maxHp), 4);
                
                // Draw Mob Name
                ctx.fillStyle = isBoss ? '#ff00ff' : (m.isElite ? '#ffff00' : '#ffaa88'); 
                ctx.font = isBoss ? 'bold 12px Arial' : (m.isElite ? 'bold 10px Arial' : '10px Arial');
                ctx.fillText(m.name, drawX, drawY - 12);
                
                if (currentTargetId === m.id) { ctx.strokeStyle = "red"; ctx.lineWidth = 2; ctx.strokeRect(drawX, drawY, size, size); ctx.lineWidth = 1; }
            }

            // Draw projectiles/spells
            const nowTime = Date.now();
            activeSpells = activeSpells.filter(s => nowTime - s.startTime < 300); // 300ms lifetime
            activeSpells.forEach(s => {
                const progress = (nowTime - s.startTime) / 300;
                const px = s.sx + (s.tx - s.sx) * progress + 16;
                const py = s.sy + (s.ty - s.sy) * progress + 16;
                
                const angle = Math.atan2(s.ty - s.sy, s.tx - s.sx);
                
                ctx.save();
                ctx.translate(px, py);
                
                if (s.type === 'mage') {
                    // Fireball (Orange/Yellow sphere with a tail)
                    ctx.rotate(angle);
                    ctx.beginPath();
                    ctx.fillStyle = '#f97316'; // Orange
                    ctx.arc(0, 0, 8, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.fillStyle = '#fbbf24'; // Yellow core
                    ctx.arc(2, 0, 4, 0, Math.PI * 2);
                    ctx.fill();
                    // Tail
                    ctx.beginPath();
                    ctx.fillStyle = 'rgba(249, 115, 22, 0.5)';
                    ctx.moveTo(0, 4);
                    ctx.lineTo(-12, 0);
                    ctx.lineTo(0, -4);
                    ctx.fill();
                } else if (s.type === 'ranger') {
                    // Arrow
                    ctx.rotate(angle);
                    ctx.strokeStyle = '#8b4513'; // Brown shaft
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(-8, 0);
                    ctx.lineTo(4, 0);
                    ctx.stroke();
                    ctx.fillStyle = '#d1d5db'; // Silver tip
                    ctx.beginPath();
                    ctx.moveTo(10, 0);
                    ctx.lineTo(4, -4);
                    ctx.lineTo(4, 4);
                    ctx.fill();
                    // Fletching
                    ctx.fillStyle = '#10b981'; // Green feather
                    ctx.beginPath();
                    ctx.moveTo(-8, 0);
                    ctx.lineTo(-12, -3);
                    ctx.lineTo(-10, 0);
                    ctx.lineTo(-12, 3);
                    ctx.fill();
                } else if (s.type === 'healer') {
                    // Holy Light (Glowing Cross)
                    ctx.fillStyle = '#fbbf24'; // Yellow
                    ctx.shadowBlur = 10;
                    ctx.shadowColor = '#fbbf24';
                    ctx.fillRect(-2, -8, 4, 16);
                    ctx.fillRect(-6, -4, 12, 4);
                    ctx.shadowBlur = 0; // Reset
                } else {
                    // Warrior Slash (Crescent Arc)
                    ctx.rotate(angle);
                    ctx.strokeStyle = '#ef4444'; // Red
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    // Draw a crescent arc sweeping forward
                    ctx.arc(0, 0, 12, -Math.PI/3, Math.PI/3);
                    ctx.stroke();
                }
                
                ctx.restore();
            });

            bossAoeEffects.forEach(aoe => {
                let color = "rgba(255,0,0,0.5)";
                if (aoe.type === "poison") color = aoe.state === "detonate" ? "rgba(0,255,0,0.8)" : "rgba(0,255,0,0.4)";
                else if (aoe.type === "ice_breath" || aoe.type === "ice_crash") color = aoe.state === "detonate" ? "rgba(0,0,255,0.8)" : "rgba(0,0,255,0.4)";
                else if (aoe.type === "death_wave") color = aoe.state === "detonate" ? "rgba(128,0,128,0.8)" : "rgba(128,0,128,0.4)";
                // Set the style before arc() so render spies can identify the
                // telegraph draw call as well as the resulting pixels.
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(aoe.x, aoe.y, aoe.radius || 50, 0, Math.PI * 2);
                ctx.fill();
            });

            for (let id in otherPlayers) {
                let op = otherPlayers[id];
                if (op.renderX === undefined) { op.renderX = op.x; op.renderY = op.y; }
                op.renderX += (op.x - op.renderX) * 0.2;
                op.renderY += (op.y - op.renderY) * 0.2;
                if (op.warmode) { ctx.fillStyle = "rgba(239, 68, 68, 0.4)"; ctx.beginPath(); ctx.arc(op.renderX + 16, op.renderY + 16, 16, 0, Math.PI * 2); ctx.fill(); }
                
                const opSprite = getSprite(op.classType);
                if (opSprite) {
                    ctx.drawImage(opSprite, op.renderX - 8, op.renderY - 16, 48, 48);
                } else {
                    let emoji = op.classType === "warrior" ? "⚔️" : op.classType === "mage" ? "🧙" : op.classType === "ranger" ? "🏹" : "👼";
                    ctx.font = "24px Arial"; ctx.fillText(emoji, op.renderX + 4, op.renderY + 24);
                }
                
                ctx.fillStyle = "white"; ctx.font = "bold 11px 'Inter'"; ctx.fillText(op.name, op.renderX - 5, op.renderY - 8);
                if (currentTargetId === id) { ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2; ctx.strokeRect(op.renderX, op.renderY, 32, 32); ctx.lineWidth = 1; }
            }

            if (player.warmode) { ctx.fillStyle = "rgba(239, 68, 68, 0.4)"; ctx.beginPath(); ctx.arc(player.x + 16, player.y + 16, 16, 0, Math.PI * 2); ctx.fill(); }
            const mySprite = getSprite(player.classType);
            if (mySprite) {
                ctx.drawImage(mySprite, player.x - 8, player.y - 16, 48, 48);
            } else {
                let myEmoji = player.classType === "warrior" ? "⚔️" : player.classType === "mage" ? "🧙" : player.classType === "ranger" ? "🏹" : "👼";
                ctx.font = "24px Arial"; ctx.fillText(myEmoji, player.x + 4, player.y + 24);
            }
            
            ctx.fillStyle = "#fbbf24"; ctx.font = "bold 12px 'Inter'"; ctx.fillText(myName, player.x - 5, player.y - 8);
            if (currentTargetId === myId) { ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 2; ctx.strokeRect(player.x, player.y, 32, 32); ctx.lineWidth = 1; }

            ctx.restore();

            if (!isDay) {
                const gradient = ctx.createRadialGradient(SCREEN_W/2, SCREEN_H/2, 50, SCREEN_W/2, SCREEN_H/2, 300);
                gradient.addColorStop(0, "rgba(0,0,0,0)");
                gradient.addColorStop(1, "rgba(0,0,20,0.85)");
                ctx.fillStyle = gradient; ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
            }

            for (let i = fcts.length - 1; i >= 0; i--) {
                let f = fcts[i];
                let alpha = f.life > 0.5 ? 1 : f.life * 2;
                let offsetY = (1 - Math.pow(f.life, 3)) * 40;
                let offsetX = f.driftX * (1 - f.life);
                
                ctx.globalAlpha = alpha;
                ctx.font = "800 16px 'Inter', sans-serif";
                
                // Text shadow for pop
                ctx.fillStyle = "rgba(0,0,0,0.8)";
                ctx.fillText(f.text, f.x - cameraX + offsetX + 1, f.y - cameraY - offsetY + 1);
                ctx.fillText(f.text, f.x - cameraX + offsetX - 1, f.y - cameraY - offsetY - 1);
                
                ctx.fillStyle = f.color; 
                ctx.fillText(f.text, f.x - cameraX + offsetX, f.y - cameraY - offsetY);
                ctx.globalAlpha = 1.0;
                
                f.life -= 0.015; if (f.life <= 0) fcts.splice(i, 1);
            }

            drawMinimap();
            
            requestAnimationFrame(draw);
        }

        // Mini-map radar. Renders a zoomed-out view centred on the player,
        // clipped to a circle. Anything outside the view radius is ignored so
        // the marker count stays proportional to what is nearby.
        const MINIMAP_SIZE = 150;
        const MINIMAP_RADIUS = 1000;
        const minimapCtx = document.getElementById("minimap-canvas").getContext("2d");
        const ZONE_COLORS = {
            City: "#3d5a45", Forest: "#2c4021", "Eastern Ruins": "#5b4c35",
            Swamp: "#2a3b32", "Snow Mountain": "#cfe3e6", Desert: "#b09a5f",
            Crypt: "#1a1a22", Wilderness: "#243026"
        };

        function worldToMini(wx, wy) {
            return {
                x: MINIMAP_SIZE / 2 + ((wx - player.x) / MINIMAP_RADIUS) * (MINIMAP_SIZE / 2),
                y: MINIMAP_SIZE / 2 + ((wy - player.y) / MINIMAP_RADIUS) * (MINIMAP_SIZE / 2)
            };
        }

        function drawMinimap() {
            if (!minimapCtx) return;
            const c = minimapCtx;
            const R = MINIMAP_SIZE / 2;

            c.clearRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
            c.save();
            c.beginPath();
            c.arc(R, R, R, 0, Math.PI * 2);
            c.clip();

            // Terrain backdrop from the obstacle list, coloured per zone.
            c.fillStyle = "#1b2a1f";
            c.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
            c.fillStyle = "rgba(120, 200, 120, 0.16)";
            for (let i = 0; i < obstacles.length; i++) {
                const o = obstacles[i];
                if (Math.abs(o.x - player.x) > MINIMAP_RADIUS || Math.abs(o.y - player.y) > MINIMAP_RADIUS) continue;
                const p = worldToMini(o.x, o.y);
                c.fillRect(p.x, p.y, 2, 2);
            }

            // Safe-zone ring so the city is always findable.
            const safe = worldToMini(640, 640);
            c.strokeStyle = "rgba(74, 222, 128, 0.55)";
            c.lineWidth = 1;
            c.strokeRect(
                MINIMAP_SIZE / 2 + ((0 - player.x) / MINIMAP_RADIUS) * R,
                MINIMAP_SIZE / 2 + ((0 - player.y) / MINIMAP_RADIUS) * R,
                (640 / MINIMAP_RADIUS) * R,
                (640 / MINIMAP_RADIUS) * R
            );

            // Mobs and bosses.
            for (let id in mobs) {
                const m = mobs[id];
                if (Math.abs(m.x - player.x) > MINIMAP_RADIUS || Math.abs(m.y - player.y) > MINIMAP_RADIUS) continue;
                const p = worldToMini(m.x, m.y);
                c.fillStyle = m.isBoss ? "#f87171" : (m.isElite ? "#fb923c" : "#ef4444");
                c.beginPath();
                c.arc(p.x, p.y, m.isBoss ? 4 : 2, 0, Math.PI * 2);
                c.fill();
            }

            // NPCs.
            for (let id in npcsLocal) {
                const n = npcsLocal[id];
                if (Math.abs(n.x - player.x) > MINIMAP_RADIUS || Math.abs(n.y - player.y) > MINIMAP_RADIUS) continue;
                const p = worldToMini(n.x, n.y);
                c.fillStyle = "#38bdf8";
                c.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
            }

            // Other players.
            for (let id in otherPlayers) {
                const op = otherPlayers[id];
                if (Math.abs(op.x - player.x) > MINIMAP_RADIUS || Math.abs(op.y - player.y) > MINIMAP_RADIUS) continue;
                const p = worldToMini(op.x, op.y);
                c.fillStyle = op.warmode ? "#f87171" : "#4ade80";
                c.beginPath();
                c.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
                c.fill();
            }

            // The player, last so it draws on top.
            c.fillStyle = "#facc15";
            c.beginPath();
            c.arc(R, R, 3.5, 0, Math.PI * 2);
            c.fill();
            c.strokeStyle = "rgba(0,0,0,0.6)";
            c.lineWidth = 1;
            c.stroke();

            c.restore();

            // North indicator.
            c.fillStyle = "rgba(255,255,255,0.55)";
            c.font = "bold 9px Inter, sans-serif";
            c.textAlign = "center";
            c.fillText("N", R, 11);
            c.textAlign = "left";
        }

        draw();
