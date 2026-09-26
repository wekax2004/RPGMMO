const fs = require('fs');
let content = fs.readFileSync('client/test_client.html', 'utf8');

content = content.replace(
    /data\.players\.forEach\(dp => \{ if \(dp\.id !== myId\) players\[dp\.id\] = dp; \}\);/,
    'data.players.forEach(dp => { if (dp.id !== myId) { if (!players[dp.id]) players[dp.id] = { ...dp, renderX: dp.x, renderY: dp.y }; else Object.assign(players[dp.id], dp); } });'
);

content = content.replace(
    /ctx\.font = size \+ "px Arial"; ctx\.fillText\(emoji, drawX, drawY \+ size - \(size > 32 \? 4 : 0\)\);/,
    'ctx.font = size + "px Arial"; ctx.fillText(emoji, drawX, drawY + size - (size > 32 ? 4 : 0));'
);

content = content.replace(
    /ctx\.fillStyle = "#ff4444"; ctx\.fillRect\(m\.x - 4, m\.y - 12, 40, 4\);/,
    'ctx.fillStyle = "#ff4444"; ctx.fillRect(m.renderX - 4, m.renderY - 12, 40, 4);'
);

content = content.replace(
    /ctx\.fillStyle = "#00ff00"; ctx\.fillRect\(m\.x - 4, m\.y - 12, 40 \* \(m\.hp \/ m\.maxHp\), 4\);/,
    'ctx.fillStyle = "#00ff00"; ctx.fillRect(m.renderX - 4, m.renderY - 12, 40 * (m.hp / m.maxHp), 4);'
);

content = content.replace(
    /ctx\.fillStyle = "#fff"; ctx\.font = "bold 10px 'Inter'"; ctx\.fillText\(m\.name, m\.x - 4, m\.y - 16\);/,
    'ctx.fillStyle = "#fff"; ctx.font = "bold 10px \\'Inter\\'"; ctx.fillText(m.name, m.renderX - 4, m.renderY - 16);'
);

content = content.replace(
    /\/\/ Player Emoji\s*ctx\.font = "28px Arial"; ctx\.fillText\("??", p\.x \+ 2, p\.y \+ 26\);\s*ctx\.fillStyle = p\.warmode \? "#ffaa00" : "#fff";\s*ctx\.font = "bold 12px 'Inter'";\s*ctx\.fillText\(p\.name, p\.x - 8, p\.y - 6\);/g,
    'if (p.renderX === undefined) { p.renderX = p.x; p.renderY = p.y; }\np.renderX += (p.x - p.renderX) * 0.2;\np.renderY += (p.y - p.renderY) * 0.2;\n// Player Emoji\nctx.font = "28px Arial"; ctx.fillText("??", p.renderX + 2, p.renderY + 26);\nctx.fillStyle = p.warmode ? "#ffaa00" : "#fff";\nctx.font = "bold 12px \\'Inter\\'";\nctx.fillText(p.name, p.renderX - 8, p.renderY - 6);'
);

fs.writeFileSync('client/test_client.html', content);
