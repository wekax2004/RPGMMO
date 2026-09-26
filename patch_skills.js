const fs = require('fs');

let serverContent = fs.readFileSync('server/server.js', 'utf8');

const spellLogic = `
            if (data.action === 'cast_spell') {
                const cost = 20;
                if (player.mana < cost) return sendTo(player, { action: 'fct', x: player.x, y: player.y, text: 'OOM', color: '#888' });
                player.mana -= cost;
                
                const spellId = data.spellIndex; // 1 or 2
                const c = player.classType;
                
                // Helper to damage a mob
                const hitMob = (m, dmg) => {
                    m.hp -= dmg;
                    broadcast({ action: 'fct', x: m.x+16, y: m.y, text: \`-\${dmg}\`, color: '#ff8866' });
                    broadcast({ action: 'mob_update', id: m.id, type: m.type, name: m.name, x: m.x, y: m.y, hp: m.hp, maxHp: m.maxHp, alive: true, isElite: m.isElite });
                    if (m.hp <= 0) killMob(player, m);
                };

                if (c === 'warrior') {
                    if (spellId === 1) { // Cleave
                        broadcast({ action: 'spell_anim', type: 'cleave', x: player.x, y: player.y });
                        for (let [mid, m] of mobs) {
                            if (dist(player.x, player.y, m.x, m.y) <= 60) hitMob(m, 50 + player.level * 2);
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
                                if (dist(t.x, t.y, m.x, m.y) <= 80) hitMob(m, 60 + player.level * 3);
                            }
                        }
                    } else { // Frost Nova
                        broadcast({ action: 'spell_anim', type: 'frostnova', x: player.x, y: player.y });
                        for (let [mid, m] of mobs) {
                            if (dist(player.x, player.y, m.x, m.y) <= 100) hitMob(m, 30 + player.level);
                        }
                    }
                } else if (c === 'ranger') {
                    if (spellId === 1) { // Multishot
                        broadcast({ action: 'spell_anim', type: 'multishot', x: player.x, y: player.y });
                        let hits = 0;
                        for (let [mid, m] of mobs) {
                            if (dist(player.x, player.y, m.x, m.y) <= 200 && hits < 3) {
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
                        player.hp = Math.min(player.maxHp, player.hp + 50 + player.level * 5);
                        broadcast({ action: 'spell_anim', type: 'heal', x: player.x, y: player.y });
                        broadcast({ action: 'fct', x: player.x, y: player.y, text: \`+50\`, color: '#44ff44' });
                    } else { // Holy Smite
                        if (player.targetId && mobs.has(player.targetId)) {
                            const t = mobs.get(player.targetId);
                            broadcast({ action: 'spell_anim', type: 'smite', x: t.x, y: t.y });
                            hitMob(t, 50 + player.level * 2);
                        }
                    }
                }
            }
`;

if (!serverContent.includes("data.action === 'cast_spell'")) {
    serverContent = serverContent.replace(
        "if (data.action === 'cast_skill') {",
        spellLogic.trim() + '\n            if (data.action === \\'cast_skill\\') {'
    );
}

fs.writeFileSync('server/server.js', serverContent);


let clientContent = fs.readFileSync('client/test_client.html', 'utf8');

const clientKeyLogic = `
            if (e.key === "1") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 1 })); return; }
            if (e.key === "2") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 2 })); return; }
`;

if (!clientContent.includes('action: "cast_spell"')) {
    clientContent = clientContent.replace(
        'if (e.key === "e" || e.key === "E") {',
        clientKeyLogic.trim() + '\n            if (e.key === "e" || e.key === "E") {'
    );
}

const spellAnimLogic = `
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
                
                bossAoeEffects.push({ x: data.x + 16, y: data.y + 16, radius: radius, state: "detonate", type: data.type });
                // We'll reuse bossAoeEffects for a quick visual burst, it expects an array.
                // We can just draw it briefly and remove it.
                setTimeout(() => { bossAoeEffects.pop(); }, 300);
            }
`;

if (!clientContent.includes('action === "spell_anim"')) {
    clientContent = clientContent.replace(
        'else if (data.action === "fct") {',
        spellAnimLogic.trim() + '\n            else if (data.action === "fct") {'
    );
}

fs.writeFileSync('client/test_client.html', clientContent);
