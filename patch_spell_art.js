const fs = require('fs');
let client = fs.readFileSync('client/test_client.html', 'utf8');

const oldDraw = `                ctx.beginPath();
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
                ctx.fill();`;

const newDraw = `                const angle = Math.atan2(s.ty - s.sy, s.tx - s.sx);
                
                ctx.save();
                ctx.translate(px, py);
                
                if (s.type === 'mage') {
                    // Fireball (Orange/Yellow sphere with a tail)
                    ctx.rotate(angle);
                    ctx.beginPath();
                    ctx.fillStyle = '#f97316'; // Orange
                    ctx.arc(0, 0, 8, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.fillStyle = '#fbbf24'; // Yellow core
                    ctx.arc(2, 0, 4, 0, Math.PI * 2);
                    ctx.fill();
                    // Tail
                    ctx.beginPath();
                    ctx.fillStyle = 'rgba(249, 115, 22, 0.5)';
                    ctx.moveTo(0, 4);
                    ctx.lineTo(-12, 0);
                    ctx.lineTo(0, -4);
                    ctx.fill();
                } else if (s.type === 'ranger') {
                    // Arrow
                    ctx.rotate(angle);
                    ctx.strokeStyle = '#8b4513'; // Brown shaft
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(-8, 0);
                    ctx.lineTo(4, 0);
                    ctx.stroke();
                    ctx.fillStyle = '#d1d5db'; // Silver tip
                    ctx.beginPath();
                    ctx.moveTo(10, 0);
                    ctx.lineTo(4, -4);
                    ctx.lineTo(4, 4);
                    ctx.fill();
                    // Fletching
                    ctx.fillStyle = '#10b981'; // Green feather
                    ctx.beginPath();
                    ctx.moveTo(-8, 0);
                    ctx.lineTo(-12, -3);
                    ctx.lineTo(-10, 0);
                    ctx.lineTo(-12, 3);
                    ctx.fill();
                } else if (s.type === 'healer') {
                    // Holy Light (Glowing Cross)
                    ctx.fillStyle = '#fbbf24'; // Yellow
                    ctx.shadowBlur = 10;
                    ctx.shadowColor = '#fbbf24';
                    ctx.fillRect(-2, -8, 4, 16);
                    ctx.fillRect(-6, -4, 12, 4);
                    ctx.shadowBlur = 0; // Reset
                } else {
                    // Warrior Slash (Crescent Arc)
                    ctx.rotate(angle);
                    ctx.strokeStyle = '#ef4444'; // Red
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    // Draw a crescent arc sweeping forward
                    ctx.arc(0, 0, 12, -Math.PI/3, Math.PI/3);
                    ctx.stroke();
                }
                
                ctx.restore();`;

if (client.includes("ctx.fillStyle = '#3b82f6';")) {
    client = client.replace(oldDraw, newDraw);
    fs.writeFileSync('client/test_client.html', client);
    console.log("Successfully patched HTML spell rendering.");
} else {
    console.log("Could not find the old drawing logic. Perhaps it was already patched?");
}
