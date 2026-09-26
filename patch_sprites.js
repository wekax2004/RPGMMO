const fs = require('fs');
let c = fs.readFileSync('client/test_client.html', 'utf8');

// 1. Add Image Loading to the top of JS
if (!c.includes('const warriorSprite = new Image();')) {
    c = c.replace(
        'let socket;',
        'let socket;\n        const warriorSprite = new Image();\n        warriorSprite.src = "warrior.jpg";'
    );
}

// 2. Patch Boss AOE Effects
const oldBossAoe = `            bossAoeEffects.forEach(aoe => {
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

const newBossAoe = `            bossAoeEffects.forEach(aoe => {
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

if (c.includes('bossAoeEffects.forEach(aoe => {')) {
    c = c.replace(oldBossAoe, newBossAoe);
}

// 3. Patch OtherPlayers Drawing to use Sprite
const oldOpDraw = `                let emoji = op.classType === "warrior" ? "⚔️" : op.classType === "mage" ? "🧙" : op.classType === "ranger" ? "🏹" : "👼";
                ctx.font = "24px Arial"; ctx.fillText(emoji, op.renderX + 4, op.renderY + 24);`;

const newOpDraw = `                if (op.classType === "warrior" && warriorSprite.complete) {
                    ctx.drawImage(warriorSprite, op.renderX, op.renderY, 32, 32);
                } else {
                    let emoji = op.classType === "warrior" ? "⚔️" : op.classType === "mage" ? "🧙" : op.classType === "ranger" ? "🏹" : "👼";
                    ctx.font = "24px Arial"; ctx.fillText(emoji, op.renderX + 4, op.renderY + 24);
                }`;
if (c.includes('op.classType === "warrior" ? "⚔️"')) {
    c = c.replace(oldOpDraw, newOpDraw);
}

// 4. Patch My Player Drawing to use Sprite
const oldMyDraw = `            let myEmoji = player.classType === "warrior" ? "⚔️" : player.classType === "mage" ? "🧙" : player.classType === "ranger" ? "🏹" : "👼";
            ctx.font = "24px Arial"; ctx.fillText(myEmoji, player.x + 4, player.y + 24);`;

const newMyDraw = `            if (player.classType === "warrior" && warriorSprite.complete) {
                ctx.drawImage(warriorSprite, player.x, player.y, 32, 32);
            } else {
                let myEmoji = player.classType === "warrior" ? "⚔️" : player.classType === "mage" ? "🧙" : player.classType === "ranger" ? "🏹" : "👼";
                ctx.font = "24px Arial"; ctx.fillText(myEmoji, player.x + 4, player.y + 24);
            }`;

if (c.includes('let myEmoji = player.classType === "warrior"')) {
    c = c.replace(oldMyDraw, newMyDraw);
}

fs.writeFileSync('client/test_client.html', c);
