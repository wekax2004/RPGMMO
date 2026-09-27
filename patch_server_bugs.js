const fs = require('fs');
let c = fs.readFileSync('server/server.js', 'utf8');

// 1. Fix Account Ownership
const oldLoginData = `                let pData;
                try {
                    pData = await DB.loadPlayer(charName);
                } catch (error) {`;
const newLoginData = `                let pData;
                try {
                    pData = await DB.loadPlayer(charName);
                    if (accountId !== null) {
                        if (pData) {
                            const owns = await AUTH.accountOwnsCharacter(accountId, charName);
                            if (!owns) {
                                clearTimeout(loginReservationTimers.get(loginKey));
                                loginReservationTimers.delete(loginKey);
                                loggingInCharacters.delete(loginKey);
                                sendTo({ ws }, { action: 'login_error', message: 'Character belongs to another account.' });
                                return;
                            }
                        } else {
                            await AUTH.bindCharacter(accountId, charName);
                        }
                    }
                } catch (error) {`;
c = c.replace(oldLoginData, newLoginData);

// 2. Fix setInterval missing try/catch
c = c.replace(/scheduleServerInterval\(\(\) => \{/g, 'scheduleServerInterval(() => {\n    try {');
// Now close the try/catch before the closing `}, INTERVAL)`
// This is a bit tricky with regex, let's write a small script inline to replace them accurately.
let lines = c.split('\n');
for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('}, CFG.') || lines[i].trim() === '}, 10000);' || lines[i].trim() === '}, 100);' || lines[i].trim() === '}, 1000);') {
        // Find previous scheduleServerInterval
        let j = i;
        let foundTry = false;
        while (j >= 0) {
            if (lines[j].includes('scheduleServerInterval')) {
                // If the next line is `try {`, then insert `} catch(e) { console.error(e); }`
                if (lines[j+1].includes('try {')) {
                    lines.splice(i, 0, '    } catch (e) { console.error("Tick error:", e); }');
                    i++; // adjust index
                }
                break;
            }
            j--;
        }
    }
}
c = lines.join('\n');

// 3. Fix Regen per sec intervals from 10000 -> 1000 (1 second)
c = c.replace('}, 10000);', '}, 1000);');
// Double check to make sure `10000` was actually the regen interval.
// Earlier: `server.js:1394:}, 10000);` was exactly the regen interval.

fs.writeFileSync('server/server.js', c);
