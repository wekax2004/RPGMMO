const fs = require('fs');
let content = fs.readFileSync('client/test_client.html', 'utf8');
content = content.replace(
    'const MAP_W = 3200, MAP_H = 3200;',
    'let MAP_W = 3200, MAP_H = 3200;\n        let SAFE_ZONE = {w: 800, h: 800};'
);
content = content.replace(
    'let obstacles = [];',
    'let obstacles = [];\n        let obstacleSet = new Set();'
);
fs.writeFileSync('client/test_client.html', content);
