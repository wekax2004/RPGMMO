const fs = require('fs');

let c = fs.readFileSync('client/test_client.html', 'utf8');

const spellAnimLogic = `
            else if (data.action === "spell_anim") {
                let color = "rgba(255, 255, 255, 0.5)";
                let radius = 30;
                if (data.type === 'cleave') { color = "rgba(255, 50, 50, 0.6)"; radius = 60; }
                else if (data.type === 'charge') { color = "rgba(200, 200, 200, 0.8)"; radius = 40; }
                else if (data.type === 'fireball') { color = "rgba(255, 100, 0, 0.7)"; radius = 80; }
                else if (data.type === 'frostnova') { color = "rgba(100, 200, 255, 0.6)"; radius = 100; }
                else if (data.type === 'multishot') { color = "rgba(150, 255, 150, 0.6)"; radius = 50; }
                else if (data.type === 'trap') { color = "rgba(100, 100, 100, 0.8)"; radius = 40; }
                else if (data.type === 'heal') { color = "rgba(50, 255, 50, 0.6)"; radius = 40; }
                else if (data.type === 'smite') { color = "rgba(255, 255, 100, 0.8)"; radius = 40; }
                
                bossAoeEffects.push({ x: data.x, y: data.y, radius: radius, state: "detonate", type: data.type });
                setTimeout(() => { bossAoeEffects.pop(); }, 300);
            }
`;

if (!c.includes('action === "spell_anim"')) {
    c = c.replace(
        'else if (data.action === "fct") { fcts.push({ text: data.text, x: data.x, y: data.y, color: data.color, life: 1.0, driftX: (Math.random() - 0.5) * 40 }); }',
        'else if (data.action === "fct") { fcts.push({ text: data.text, x: data.x, y: data.y, color: data.color, life: 1.0, driftX: (Math.random() - 0.5) * 40 }); }\n' + spellAnimLogic.trim()
    );
}

const keyLogic = `
            if (e.key === "1") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 1 })); return; }
            if (e.key === "2") { socket.send(JSON.stringify({ action: "cast_spell", spellIndex: 2 })); return; }
`;

if (!c.includes('action: "cast_spell"')) {
    c = c.replace(
        'else if (e.key === "Enter") chatInput.focus();',
        'else if (e.key === "Enter") chatInput.focus();\n' + keyLogic.trim()
    );
}

fs.writeFileSync('client/test_client.html', c);
