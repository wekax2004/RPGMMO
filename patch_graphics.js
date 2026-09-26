const fs = require('fs');
let c = fs.readFileSync('client/test_client.html', 'utf8');

const cssToInsert = `
        #minimap-container {
            position: absolute;
            top: 20px;
            right: 20px;
            width: 150px;
            height: 150px;
            border-radius: 50%;
            background: rgba(15, 23, 42, 0.8);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            border: 2px solid rgba(255,255,255,0.1);
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            overflow: hidden;
            z-index: 2;
        }
        #minimap-canvas {
            width: 100%;
            height: 100%;
        }
`;
if (!c.includes('#minimap-container')) {
    c = c.replace('</style>', cssToInsert + '\n    </style>');
}

const htmlToInsert = `
    <div id="minimap-container">
        <canvas id="minimap-canvas" width="150" height="150"></canvas>
    </div>
`;
if (!c.includes('id="minimap-container"')) {
    c = c.replace('<div id="game-wrapper">', htmlToInsert + '\n    <div id="game-wrapper">');
}

const bossAoeReplace = `            bossAoeEffects.forEach(aoe => {
                let color = "rgba(255,0,0,0.5)";
                if (aoe.type === "poison") color = aoe.state === "detonate" ? "rgba(0,255,0,0.8)" : "rgba(0,255,0,0.4)";
                else if (aoe.type === "ice_breath" || aoe.type === "ice_crash") color = aoe.state === "detonate" ? "rgba(0,0,255,0.8)" : "rgba(0,0,255,0.4)";
                else if (aoe.type === "death_wave") color = aoe.state === "detonate" ? "rgba(128,0,128,0.8)" : "rgba(128,0,128,0.4)";
                // Set the style before arc() so render spies can identify the
                // telegraph draw call as well as the resulting pixels.
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(aoe.x, aoe.y, aoe.radius || 50, 0, Math.PI * 2);
                ctx.fill();
            });`;

const bossAoeNew = `            bossAoeEffects.forEach(aoe => {
                let r=255, g=0, b=0;
                if (aoe.type === "poison") { r=50; g=255; b=50; }
                else if (aoe.type === "ice_breath" || aoe.type === "ice_crash" || aoe.type === "frostnova") { r=100; g=200; b=255; }
                else if (aoe.type === "death_wave" || aoe.type === "trap") { r=150; g=50; b=200; }
                else if (aoe.type === "heal") { r=50; g=255; b=100; }
                else if (aoe.type === "smite" || aoe.type === "cleave") { r=255; g=200; b=50; }
                
                const rad = aoe.radius || 50;
                
                // Draw Warning Pulse
                if (aoe.state === "warning") {
                    ctx.beginPath();
                    ctx.arc(aoe.x, aoe.y, rad, 0, Math.PI * 2);
                    ctx.fillStyle = \`rgba(\${r},\${g},\${b},0.15)\`;
                    ctx.fill();
                    ctx.lineWidth = 2;
                    ctx.strokeStyle = \`rgba(\${r},\${g},\${b},0.8)\`;
                    ctx.setLineDash([5, 5]);
                    ctx.stroke();
                    ctx.setLineDash([]);
                } else {
                    // Draw Explosion Gradient
                    const grad = ctx.createRadialGradient(aoe.x, aoe.y, 0, aoe.x, aoe.y, rad);
                    grad.addColorStop(0, \`rgba(255,255,255,0.9)\`);
                    grad.addColorStop(0.3, \`rgba(\${r},\${g},\${b},0.8)\`);
                    grad.addColorStop(1, \`rgba(\${r},\${g},\${b},0)\`);
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(aoe.x, aoe.y, rad, 0, Math.PI * 2);
                    ctx.fill();
                }
            });
            
            // Draw Entity Shadows
            const drawShadow = (ex, ey) => {
                ctx.fillStyle = "rgba(0,0,0,0.4)";
                ctx.beginPath();
                ctx.ellipse(ex + 16, ey + 28, 12, 6, 0, 0, Math.PI * 2);
                ctx.fill();
            };
            drawShadow(player.x, player.y);
            for (let id in otherPlayers) drawShadow(otherPlayers[id].renderX, otherPlayers[id].renderY);
            for (let id in mobs) drawShadow(mobs[id].renderX, mobs[id].renderY);`;

if (c.includes('bossAoeEffects.forEach(aoe => {') && !c.includes('createRadialGradient')) {
    c = c.replace(bossAoeReplace, bossAoeNew);
}

const minimapLogic = `
        function drawMinimap() {
            const mCanvas = document.getElementById("minimap-canvas");
            if (!mCanvas) return;
            const mCtx = mCanvas.getContext("2d");
            
            mCtx.clearRect(0, 0, 150, 150);
            
            const scale = 150 / 1500;
            
            mCtx.save();
            mCtx.translate(75, 75);
            mCtx.scale(scale, scale);
            mCtx.translate(-player.x, -player.y);
            
            mCtx.fillStyle = "#1e293b";
            mCtx.fillRect(0, 0, 3200, 3200);
            
            mCtx.fillStyle = "#0f172a";
            obstacleSet.forEach(key => {
                const parts = key.split(",");
                mCtx.fillRect(parseInt(parts[0]), parseInt(parts[1]), 32, 32);
            });
            
            mCtx.fillStyle = "#ef4444";
            for (let id in mobs) {
                mCtx.beginPath();
                mCtx.arc(mobs[id].x, mobs[id].y, 20, 0, Math.PI*2);
                mCtx.fill();
            }
            
            mCtx.fillStyle = "#22c55e";
            for (let id in otherPlayers) {
                mCtx.beginPath();
                mCtx.arc(otherPlayers[id].x, otherPlayers[id].y, 20, 0, Math.PI*2);
                mCtx.fill();
            }
            
            mCtx.fillStyle = "#eab308";
            mCtx.beginPath();
            mCtx.arc(player.x, player.y, 24, 0, Math.PI*2);
            mCtx.fill();
            
            mCtx.restore();
        }
`;

if (!c.includes('drawMinimap()')) {
    c = c.replace('requestAnimationFrame(gameLoop);', 'drawMinimap();\n            requestAnimationFrame(gameLoop);');
    c = c.replace('function gameLoop() {', minimapLogic + '\n        function gameLoop() {');
}

fs.writeFileSync('client/test_client.html', c);
