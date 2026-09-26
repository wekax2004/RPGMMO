const fs = require('fs');

// ==== SERVER.JS PATCH ====
let serverContent = fs.readFileSync('server/server.js', 'utf8');

const newDeathLogic = 
function checkPlayerDeath(player, killerName = 'Unknown') {
    if (player.hp <= 0) {
        broadcast({ action: 'log', message: '?? ' + player.charName + ' was slain by ' + killerName + '!' });
        
        const droppedGold = Math.floor(player.gold * 0.5);
        player.gold -= droppedGold;
        
        const req = player.level * 100;
        const xpPenalty = Math.floor(req * 0.1);
        player.xp -= xpPenalty;
        if (player.xp < 0 && player.level > 1) {
            player.level--;
            player.xp = (player.level * 100) + player.xp;
        } else if (player.xp < 0) {
            player.xp = 0;
        }

        const cid = "corpse_" + Date.now() + "_" + Math.floor(Math.random()*1000);
        corpses.set(cid, { id: cid, x: player.x, y: player.y, gold: droppedGold, ownerName: player.charName, expireAt: Date.now() + 120000 });
        broadcast({ action: 'corpse_spawn', corpse: corpses.get(cid) });

        player.hp = player.maxHp; player.mana = player.maxMana; 
        player.poisonStacks = 0; player.bleedStacks = 0; player.stunUntil = 0;
        player.x = 320; player.y = 320; player.targetId = null;
        sendTo(player, { action: 'force_position', x: 320, y: 320 });
    }
};

serverContent = serverContent.replace(
    /function checkPlayerDeath\(player, killerName = 'Unknown'\) \{[\s\S]*?\n\}/,
    newDeathLogic.trim()
);

serverContent = serverContent.replace(
    'const npcs = new Map();',
    'const npcs = new Map();\\nconst corpses = new Map();'
);

serverContent = serverContent.replace(
    '    // Respawn Gathering Nodes',
    '    const now = Date.now();\\n    for (const [id, c] of corpses.entries()) {\\n        if (now > c.expireAt) {\\n            corpses.delete(id);\\n            broadcast({ action: \\'corpse_remove\\', id });\\n        }\\n    }\\n\\n    // Respawn Gathering Nodes'
);

fs.writeFileSync('server/server.js', serverContent);


// ==== CLIENT.JS PATCH ====
let clientContent = fs.readFileSync('client/test_client.html', 'utf8');

clientContent = clientContent.replace(
    'let chests = {};',
    'let chests = {};\\n        let clientCorpses = {};'
);

clientContent = clientContent.replace(
    'else if (data.action === "chest_update")',
    'else if (data.action === "corpse_spawn") { clientCorpses[data.corpse.id] = data.corpse; }\\n            else if (data.action === "corpse_remove") { delete clientCorpses[data.id]; }\\n            else if (data.action === "chest_update")'
);

clientContent = clientContent.replace(
    '            if (e.key === "e" || e.key === "E") {',
    '            if (e.key === "e" || e.key === "E") {\\n                for(let id in clientCorpses) {\\n                    if(Math.abs(player.x - clientCorpses[id].x) + Math.abs(player.y - clientCorpses[id].y) <= 64) {\\n                        socket.send(JSON.stringify({ action: "interact_corpse", id: id }));\\n                        return;\\n                    }\\n                }'
);

clientContent = clientContent.replace(
    '            for (let id in chests) {',
    '            for (let id in clientCorpses) {\\n                let c = clientCorpses[id];\\n                ctx.font = "24px Arial"; ctx.fillText("??", c.x + 4, c.y + 24);\\n            }\\n            for (let id in chests) {'
);

fs.writeFileSync('client/test_client.html', clientContent);
