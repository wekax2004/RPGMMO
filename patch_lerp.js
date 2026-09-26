const fs = require('fs');
let content = fs.readFileSync('client/test_client.html', 'utf8');

// 1. Update players_sync to preserve renderX/renderY
content = content.replace(
    'data.players.forEach(dp => { if (dp.id !== myId) players[dp.id] = dp; });',
    'data.players.forEach(dp => { if (dp.id !== myId) { if (!players[dp.id]) players[dp.id] = { ...dp, renderX: dp.x, renderY: dp.y }; else Object.assign(players[dp.id], dp); } });'
);

// 2. Update mob_update to initialize renderX/renderY
content = content.replace(
    'if (data.alive) mobs[data.id] = { x: data.x, y: data.y, id: data.id, hp: data.hp, maxHp: data.maxHp, isElite: data.isElite, isBoss: data.isBoss, name: data.name, type: data.type, phase: data.phase || 1 };',
    'if (data.alive) { if(!mobs[data.id]) mobs[data.id] = { x: data.x, y: data.y, id: data.id, hp: data.hp, maxHp: data.maxHp, isElite: data.isElite, isBoss: data.isBoss, name: data.name, type: data.type, phase: data.phase || 1, renderX: data.x, renderY: data.y }; else { mobs[data.id].hp = data.hp; mobs[data.id].maxHp = data.maxHp; mobs[data.id].x = data.x; mobs[data.id].y = data.y; } }'
);

// 3. Interpolate mobs in draw loop
content = content.replace(
    'let drawX = m.x - (size - 32)/2;\n                let drawY = m.y - (size - 32)/2;\n\n                if (m.isElite) { ctx.fillStyle = "rgba(255,0,0,0.2)"; ctx.beginPath(); ctx.arc(m.x + 16, m.y + 16, 20, 0, Math.PI*2); ctx.fill(); }',
    'if (m.renderX === undefined) { m.renderX = m.x; m.renderY = m.y; }\n                m.renderX += (m.x - m.renderX) * 0.2;\n                m.renderY += (m.y - m.renderY) * 0.2;\n                let drawX = m.renderX - (size - 32)/2;\n                let drawY = m.renderY - (size - 32)/2;\n\n                if (m.isElite) { ctx.fillStyle = "rgba(255,0,0,0.2)"; ctx.beginPath(); ctx.arc(m.renderX + 16, m.renderY + 16, 20, 0, Math.PI*2); ctx.fill(); }'
);

// 4. Update boss arc using renderX
content = content.replace(
    'ctx.beginPath(); ctx.arc(m.x + 16, m.y + 16, 32, 0, Math.PI*2); ctx.fill();',
    'ctx.beginPath(); ctx.arc(m.renderX + 16, m.renderY + 16, 32, 0, Math.PI*2); ctx.fill();'
);

// 5. Update mob emojis using renderX
content = content.replace(
    'ctx.font = size + "px Arial"; ctx.fillText(emoji, drawX, drawY + size - (size > 32 ? 4 : 0));\n                \n                ctx.fillStyle = "#ff4444"; ctx.fillRect(m.x - 4, m.y - 12, 40, 4);\n                ctx.fillStyle = "#00ff00"; ctx.fillRect(m.x - 4, m.y - 12, 40 * (m.hp / m.maxHp), 4);\n                ctx.fillStyle = "#fff"; ctx.font = "bold 10px \\'Inter\\'"; ctx.fillText(m.name, m.x - 4, m.y - 16);',
    'ctx.font = size + "px Arial"; ctx.fillText(emoji, drawX, drawY + size - (size > 32 ? 4 : 0));\n                \n                ctx.fillStyle = "#ff4444"; ctx.fillRect(m.renderX - 4, m.renderY - 12, 40, 4);\n                ctx.fillStyle = "#00ff00"; ctx.fillRect(m.renderX - 4, m.renderY - 12, 40 * (m.hp / m.maxHp), 4);\n                ctx.fillStyle = "#fff"; ctx.font = "bold 10px \\'Inter\\'"; ctx.fillText(m.name, m.renderX - 4, m.renderY - 16);'
);

// 6. Interpolate players in draw loop
content = content.replace(
    'const p = players[id];\n                ctx.fillStyle = (p.classType === "mage") ? "#00aaff" : (p.classType === "ranger") ? "#55ff55" : (p.classType === "healer") ? "#44ff88" : "#ffaa00";\n                \n                // Player Emoji\n                ctx.font = "28px Arial"; ctx.fillText("??", p.x + 2, p.y + 26);\n                \n                ctx.fillStyle = p.warmode ? "#ffaa00" : "#fff";\n                ctx.font = "bold 12px \\'Inter\\'";\n                ctx.fillText(p.name, p.x - 8, p.y - 6);',
    'const p = players[id];\n                if (p.renderX === undefined) { p.renderX = p.x; p.renderY = p.y; }\n                p.renderX += (p.x - p.renderX) * 0.2;\n                p.renderY += (p.y - p.renderY) * 0.2;\n                ctx.fillStyle = (p.classType === "mage") ? "#00aaff" : (p.classType === "ranger") ? "#55ff55" : (p.classType === "healer") ? "#44ff88" : "#ffaa00";\n                \n                // Player Emoji\n                ctx.font = "28px Arial"; ctx.fillText("??", p.renderX + 2, p.renderY + 26);\n                \n                ctx.fillStyle = p.warmode ? "#ffaa00" : "#fff";\n                ctx.font = "bold 12px \\'Inter\\'";\n                ctx.fillText(p.name, p.renderX - 8, p.renderY - 6);'
);

fs.writeFileSync('client/test_client.html', content);
