const fs = require('fs');

let serverContent = fs.readFileSync('server/server.js', 'utf8');

if (!serverContent.includes('const corpses = new Map();')) {
    serverContent = serverContent.replace(
        'const { npcs } = require(\\'./npcs\\');',
        'const { npcs } = require(\\'./npcs\\');\\nconst corpses = new Map();\\nlet corpseIdCounter = 1;'
    );
}

if (!serverContent.includes('// Corpse decay')) {
    serverContent = serverContent.replace(
        '// Respawn Gathering Nodes',
        '// Corpse decay\\n    const now = Date.now();\\n    for (const [id, c] of corpses.entries()) {\\n        if (now > c.expireAt) {\\n            corpses.delete(id);\\n            broadcast({ action: \\'corpse_remove\\', id });\\n        }\\n    }\\n\\n    // Respawn Gathering Nodes'
    );
}

fs.writeFileSync('server/server.js', serverContent);


let clientContent = fs.readFileSync('client/test_client.html', 'utf8');

if (!clientContent.includes('let clientCorpses = {};')) {
    clientContent = clientContent.replace(
        'let chests = {};',
        'let chests = {};\\n        let clientCorpses = {};'
    );
}

if (!clientContent.includes('corpse_spawn')) {
    clientContent = clientContent.replace(
        'else if (data.action === "chest_update")',
        'else if (data.action === "corpse_spawn") { clientCorpses[data.corpse.id] = data.corpse; }\\n            else if (data.action === "corpse_remove") { delete clientCorpses[data.id]; }\\n            else if (data.action === "chest_update")'
    );
}

if (!clientContent.includes('interact_corpse')) {
    clientContent = clientContent.replace(
        /if \(e\.key === "e" \|\| e\.key === "E"\) \{/,
        'if (e.key === "e" || e.key === "E") {\\n                for(let id in clientCorpses) {\\n                    if(Math.abs(player.x - clientCorpses[id].x) + Math.abs(player.y - clientCorpses[id].y) <= 64) {\\n                        socket.send(JSON.stringify({ action: "interact_corpse", id: id }));\\n                        return;\\n                    }\\n                }'
    );
}

if (!clientContent.includes('??')) {
    clientContent = clientContent.replace(
        /for \(let id in chests\) \{/,
        'for (let id in clientCorpses) {\\n                let c = clientCorpses[id];\\n                ctx.font = "24px Arial"; ctx.fillText("??", c.x + 4, c.y + 24);\\n            }\\n            for (let id in chests) {'
    );
}

fs.writeFileSync('client/test_client.html', clientContent);
