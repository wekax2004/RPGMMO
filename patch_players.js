const fs = require('fs');
let content = fs.readFileSync('client/test_client.html', 'utf8');

// 1. Update players_sync to preserve existing state and add render properties
content = content.replace(
    '                otherPlayers = {}; \\n                data.players.forEach(p => { \\n                    if (p.id !== myId) otherPlayers[p.id] = { x: p.x, y: p.y, classType: p.classType, name: p.name, warmode: p.warmode }; \\n                    else { player.x = p.x; player.y = p.y; player.classType = p.classType; player.warmode = p.warmode; }\\n                });',
    '                let newIds = data.players.map(p => p.id);\\n                data.players.forEach(p => { \\n                    if (p.id !== myId) {\\n                        if (!otherPlayers[p.id]) otherPlayers[p.id] = { x: p.x, y: p.y, renderX: p.x, renderY: p.y, classType: p.classType, name: p.name, warmode: p.warmode };\\n                        else { otherPlayers[p.id].x = p.x; otherPlayers[p.id].y = p.y; otherPlayers[p.id].classType = p.classType; otherPlayers[p.id].warmode = p.warmode; }\\n                    } else { player.x = p.x; player.y = p.y; player.classType = p.classType; player.warmode = p.warmode; }\\n                });\\n                for (let id in otherPlayers) { if (!newIds.includes(id)) delete otherPlayers[id]; }'
);

// 2. Interpolate otherPlayers
content = content.replace(
    '            for (let id in otherPlayers) {\\n                let op = otherPlayers[id];\\n                if (op.warmode) { ctx.fillStyle = "rgba(239, 68, 68, 0.4)"; ctx.beginPath(); ctx.arc(op.x + 16, op.y + 16, 16, 0, Math.PI * 2); ctx.fill(); }',
    '            for (let id in otherPlayers) {\\n                let op = otherPlayers[id];\\n                if (op.renderX === undefined) { op.renderX = op.x; op.renderY = op.y; }\\n                op.renderX += (op.x - op.renderX) * 0.2; op.renderY += (op.y - op.renderY) * 0.2;\\n                if (op.warmode) { ctx.fillStyle = "rgba(239, 68, 68, 0.4)"; ctx.beginPath(); ctx.arc(op.renderX + 16, op.renderY + 16, 16, 0, Math.PI * 2); ctx.fill(); }'
);

// Update emoji position
content = content.replace(
    '                ctx.font = "28px Arial"; ctx.fillText("??", op.x + 2, op.y + 26);\\n                ctx.fillStyle = op.warmode ? "#ffaa00" : "#fff"; ctx.font = "bold 12px \\'Inter\\'"; ctx.fillText(op.name, op.x - 4, op.y - 8);',
    '                ctx.font = "28px Arial"; ctx.fillText("??", op.renderX + 2, op.renderY + 26);\\n                ctx.fillStyle = op.warmode ? "#ffaa00" : "#fff"; ctx.font = "bold 12px \\'Inter\\'"; ctx.fillText(op.name, op.renderX - 4, op.renderY - 8);'
);


fs.writeFileSync('client/test_client.html', content);
