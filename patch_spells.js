const fs = require('fs');

// Patch backend server.js to emit spell events
let server = fs.readFileSync('server/server.js', 'utf8');

// For player vs player
server = server.replace(
    "target.hp -= damage; applyLifesteal(player, damage);\n                        broadcast({ action: 'fct'",
    "target.hp -= damage; applyLifesteal(player, damage);\n                        broadcast({ action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: target.x, ty: target.y });\n                        broadcast({ action: 'fct'"
);

// For player vs mob
server = server.replace(
    "target.hp -= damage; applyLifesteal(player, damage);\n                    broadcast({ action: 'fct'",
    "target.hp -= damage; applyLifesteal(player, damage);\n                    broadcast({ action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: target.x, ty: target.y });\n                    broadcast({ action: 'fct'"
);

// For player vs boss
server = server.replace(
    "boss.hp -= damage; applyLifesteal(player, damage);\n                    broadcast({ action: 'fct'",
    "boss.hp -= damage; applyLifesteal(player, damage);\n                    broadcast({ action: 'spell', type: player.classType, sx: player.x, sy: player.y, tx: boss.x, ty: boss.y });\n                    broadcast({ action: 'fct'"
);

fs.writeFileSync('server/server.js', server);

// Patch frontend test_client.html to render spells
let client = fs.readFileSync('client/test_client.html', 'utf8');

const oldDrawLoop = `            bossAoeEffects.forEach(aoe => {`;

const newDrawLoop = `            // Draw projectiles/spells
            const nowTime = Date.now();
            activeSpells = activeSpells.filter(s => nowTime - s.startTime < 300); // 300ms lifetime
            activeSpells.forEach(s => {
                const progress = (nowTime - s.startTime) / 300;
                const px = s.sx + (s.tx - s.sx) * progress + 16;
                const py = s.sy + (s.ty - s.sy) * progress + 16;
                
                ctx.beginPath();
                if (s.type === 'mage') {
                    ctx.fillStyle = '#3b82f6'; // Blue fireball
                    ctx.arc(px, py, 6, 0, Math.PI * 2);
                } else if (s.type === 'ranger') {
                    ctx.fillStyle = '#10b981'; // Green arrow
                    ctx.arc(px, py, 4, 0, Math.PI * 2);
                } else if (s.type === 'healer') {
                    ctx.fillStyle = '#fbbf24'; // Holy light
                    ctx.arc(px, py, 6, 0, Math.PI * 2);
                } else {
                    ctx.fillStyle = '#ef4444'; // Red slash (Warrior)
                    ctx.arc(px, py, 5, 0, Math.PI * 2);
                }
                ctx.fill();
            });

            bossAoeEffects.forEach(aoe => {`;

if (!client.includes('activeSpells = activeSpells.filter')) {
    client = client.replace(oldDrawLoop, newDrawLoop);
}

const oldSocketLogic = `            else if (data.action === "boss_aoe_telegraph") { bossAoeEffects.push({ x: data.x, y: data.y, radius: data.radius, type: data.type, state: "telegraph", id: data.id }); }`;
const newSocketLogic = `            else if (data.action === "spell") { activeSpells.push({ sx: data.sx, sy: data.sy, tx: data.tx, ty: data.ty, type: data.type, startTime: Date.now() }); }
            else if (data.action === "boss_aoe_telegraph") { bossAoeEffects.push({ x: data.x, y: data.y, radius: data.radius, type: data.type, state: "telegraph", id: data.id }); }`;

if (!client.includes('else if (data.action === "spell")')) {
    client = client.replace(oldSocketLogic, newSocketLogic);
    
    // add global variable
    client = client.replace("let bossAoeEffects = [];", "let bossAoeEffects = [];\n        let activeSpells = [];");
}

fs.writeFileSync('client/test_client.html', client);
