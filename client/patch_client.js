const fs = require('fs');

let html = fs.readFileSync('test_client.html', 'utf8');

// Update MAP_W and MAP_H
html = html.replace('const MAP_W = 2560, MAP_H = 2560;', 'const MAP_W = 3200, MAP_H = 3200;');

// Inject obstacles parsing
if (!html.includes('else if (data.action === \'map_data\') { obstacles = data.obstacles; }')) {
    html = html.replace(
        "if (data.action === 'show_class_select') {",
        "if (data.action === 'show_class_select') {\n                document.getElementById('overlay').style.display = 'block';\n                document.getElementById('class-modal').style.display = 'block';\n            }\n            else if (data.action === 'map_data') { obstacles = data.obstacles; }"
    );
}

// Ensure obstacles array is initialized
if (!html.includes('let obstacles = [];')) {
    html = html.replace('let otherPlayers', 'let obstacles = [];\n        let otherPlayers');
}

// Add isWalkable check
if (!html.includes('function isWalkable(nx, ny)')) {
    html = html.replace(
        'let lastMoveTime = 0;',
        `let lastMoveTime = 0;\n        function isWalkable(nx, ny) {
            if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) return false;
            for(let i=0; i<obstacles.length; i++) {
                if(obstacles[i].x === nx && obstacles[i].y === ny) return false;
            }
            return true;
        }`
    );
}

// Use isWalkable in move logic
html = html.replace(
    'if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) return;',
    'if (!isWalkable(nx, ny)) return;'
);

// Overwrite the background drawing logic inside draw()
const bgDrawing = `            // Clear Screen
            ctx.fillStyle = '#111'; ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);

            ctx.save();
            ctx.translate(-cameraX, -cameraY);

            // Draw Biomes
            ctx.fillStyle = '#8f9779'; // City
            ctx.fillRect(0, 0, 1600, 1600);
            ctx.fillStyle = '#2d5a27'; // Forest
            ctx.fillRect(1600, 0, 1600, 1600);
            ctx.fillStyle = '#e0f7fa'; // Snow
            ctx.fillRect(0, 1600, 1600, 1600);
            ctx.fillStyle = '#5d4037'; // Ruins
            ctx.fillRect(1600, 1600, 1600, 1600);

            // Draw Safe Zone specifically
            ctx.fillStyle = 'rgba(0, 255, 100, 0.2)';
            ctx.fillRect(0, 0, 640, 640);

            // Draw Grid
            ctx.strokeStyle = 'rgba(0,0,0,0.1)';
            for (let x = 0; x <= MAP_W; x += 32) {
                if (x >= cameraX && x <= cameraX + SCREEN_W) {
                    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, MAP_H); ctx.stroke();
                }
            }
            for (let y = 0; y <= MAP_H; y += 32) {
                if (y >= cameraY && y <= cameraY + SCREEN_H) {
                    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(MAP_W, y); ctx.stroke();
                }
            }

            // Draw Obstacles
            obstacles.forEach(obs => {
                if (obs.x < cameraX - 32 || obs.x > cameraX + SCREEN_W || obs.y < cameraY - 32 || obs.y > cameraY + SCREEN_H) return;
                if (obs.type === 'tree') {
                    ctx.fillStyle = '#1b3e15'; ctx.fillRect(obs.x, obs.y, 32, 32);
                } else if (obs.type === 'rock') {
                    ctx.fillStyle = '#757575'; ctx.beginPath(); ctx.arc(obs.x + 16, obs.y + 16, 14, 0, Math.PI*2); ctx.fill();
                } else if (obs.type === 'wall') {
                    ctx.fillStyle = '#424242'; ctx.fillRect(obs.x, obs.y, 32, 32);
                }
            });`;

const origBgStart = html.indexOf('            ctx.fillStyle = \'#223322\'; ctx.fillRect(0, 0, MAP_W, MAP_H);');
const origBgEnd = html.indexOf('            const startX = Math.floor(cameraX / 32) * 32;') + 150; // Skip grid drawing

if (origBgStart > -1) {
    // We will do a regex replacement for the old drawing commands
    // Just easier to replace everything from "ctx.fillStyle = '#223322'" to just before drawing nodes
    const beforeDraw = html.substring(0, origBgStart);
    const nodesStart = html.indexOf('            for (let nid in gatherNodes) {');
    const afterDraw = html.substring(nodesStart);
    
    html = beforeDraw + bgDrawing + '\n\n' + afterDraw;
}

// Update translation for all entities: Since we put ctx.translate(-cameraX, -cameraY), we must remove -cameraX and -cameraY from ALL drawing commands!
// This is tedious to regex safely. 
// Wait! Let's NOT use ctx.translate if we don't want to rewrite all other drawing commands.
// Let's rewrite bgDrawing to use -cameraX, -cameraY.
const newBgDrawing = `            // Draw Biomes
            ctx.fillStyle = '#8f9779'; // City
            ctx.fillRect(0 - cameraX, 0 - cameraY, 1600, 1600);
            ctx.fillStyle = '#2d5a27'; // Forest
            ctx.fillRect(1600 - cameraX, 0 - cameraY, 1600, 1600);
            ctx.fillStyle = '#e0f7fa'; // Snow
            ctx.fillRect(0 - cameraX, 1600 - cameraY, 1600, 1600);
            ctx.fillStyle = '#5d4037'; // Ruins
            ctx.fillRect(1600 - cameraX, 1600 - cameraY, 1600, 1600);

            // Draw Safe Zone specifically
            ctx.fillStyle = 'rgba(0, 255, 100, 0.2)';
            ctx.fillRect(0 - cameraX, 0 - cameraY, 640, 640);

            // Draw Grid
            ctx.strokeStyle = 'rgba(0,0,0,0.1)';
            for (let x = 0; x <= MAP_W; x += 32) {
                if (x >= cameraX && x <= cameraX + SCREEN_W) {
                    ctx.beginPath(); ctx.moveTo(x - cameraX, 0); ctx.lineTo(x - cameraX, SCREEN_H); ctx.stroke();
                }
            }
            for (let y = 0; y <= MAP_H; y += 32) {
                if (y >= cameraY && y <= cameraY + SCREEN_H) {
                    ctx.beginPath(); ctx.moveTo(0, y - cameraY); ctx.lineTo(SCREEN_W, y - cameraY); ctx.stroke();
                }
            }

            // Draw Obstacles
            obstacles.forEach(obs => {
                if (obs.x < cameraX - 32 || obs.x > cameraX + SCREEN_W || obs.y < cameraY - 32 || obs.y > cameraY + SCREEN_H) return;
                if (obs.type === 'tree') {
                    ctx.fillStyle = '#1b3e15'; ctx.fillRect(obs.x - cameraX, obs.y - cameraY, 32, 32);
                } else if (obs.type === 'rock') {
                    ctx.fillStyle = '#757575'; ctx.beginPath(); ctx.arc(obs.x - cameraX + 16, obs.y - cameraY + 16, 14, 0, Math.PI*2); ctx.fill();
                } else if (obs.type === 'wall') {
                    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(obs.x - cameraX, obs.y - cameraY, 32, 32);
                }
            });`;

if (origBgStart > -1) {
    const beforeDraw = html.substring(0, origBgStart);
    const nodesStart = html.indexOf('            for (let nid in gatherNodes) {');
    const afterDraw = html.substring(nodesStart);
    html = beforeDraw + newBgDrawing + '\n\n' + afterDraw;
}

// Also fix mob colors
html = html.replace(
    "let baseColor = m.type === 'spider' ? '#cc2222' : m.type === 'minotaur' ? '#884422' : '#555555';",
    "let baseColor = m.type === 'spider' ? '#cc2222' : m.type === 'minotaur' ? '#884422' : m.type === 'bear' ? '#5c4033' : m.type === 'yeti' ? '#ffffff' : '#555555';"
);
html = html.replace(
    "ctx.fillStyle = baseColor; ctx.fillRect(m.x+2,m.y+2,28,28); ctx.strokeRect(m.x+2,m.y+2,28,28); ctx.shadowBlur = 0;",
    "ctx.fillStyle = baseColor; ctx.fillRect(m.x+2,m.y+2,28,28); ctx.strokeStyle = (m.type === 'yeti') ? '#000' : baseColor; ctx.strokeRect(m.x+2,m.y+2,28,28); ctx.shadowBlur = 0;"
);

// Minimap safe zone fix
html = html.replace(
    "ctx.fillRect(mx, my, (400/MAP_W)*mw, (400/MAP_H)*mh);",
    "ctx.fillRect(mx, my, (640/MAP_W)*mw, (640/MAP_H)*mh);"
);

fs.writeFileSync('test_client.html', html);
console.log('Patch complete.');
