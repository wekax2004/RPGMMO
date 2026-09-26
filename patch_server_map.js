const fs = require('fs');
let content = fs.readFileSync('server/server.js', 'utf8');
content = content.replace(
    'sendTo(player, { action: \\'map_data\\', obstacles: obstacleData });',
    'sendTo(player, { action: \\'map_data\\', obstacles: obstacleData, width: CFG.MAP_WIDTH, height: CFG.MAP_HEIGHT, safeZone: CFG.SAFE_ZONE });'
);
fs.writeFileSync('server/server.js', content);
