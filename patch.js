const fs = require('fs');

let s = fs.readFileSync('server/server.js', 'utf8');

// Corpse decay
if (!s.includes('// Corpse decay')) {
    s = s.replace(
        '    // Respawn Gathering Nodes',
        '    // Corpse decay\n    const now = Date.now();\n    for (const [id, c] of corpses.entries()) {\n        if (now > c.expireAt) {\n            corpses.delete(id);\n            broadcast({ action: "corpse_remove", id });\n        }\n    }\n\n    // Respawn Gathering Nodes'
    );
}
fs.writeFileSync('server/server.js', s);

let c = fs.readFileSync('client/test_client.html', 'utf8');
if (!c.includes('clientCorpses = {}')) {
    c = c.replace(
        'let chests = {};',
        'let chests = {};\n        let clientCorpses = {};'
    );
    c = c.replace(
        'else if (data.action === "chest_update")',
        'else if (data.action === "corpse_spawn") { clientCorpses[data.corpse.id] = data.corpse; }\n            else if (data.action === "corpse_remove") { delete clientCorpses[data.id]; }\n            else if (data.action === "chest_update")'
    );
    c = c.replace(
        'if (e.key === "e" || e.key === "E") {',
        'if (e.key === "e" || e.key === "E") {\n                for(let id in clientCorpses) {\n                    if(Math.abs(player.x - clientCorpses[id].x) + Math.abs(player.y - clientCorpses[id].y) <= 64) {\n                        socket.send(JSON.stringify({ action: "interact_corpse", id: id }));\n                        return;\n                    }\n                }'
    );
    c = c.replace(
        'for (let id in chests) {',
        'for (let id in clientCorpses) {\n                let corpse = clientCorpses[id];\n                ctx.font = "24px Arial"; ctx.fillText("☠️", corpse.x + 4, corpse.y + 24);\n            }\n            for (let id in chests) {'
    );
}
fs.writeFileSync('client/test_client.html', c);
