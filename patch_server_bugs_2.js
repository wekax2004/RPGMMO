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
let lines = c.split('\n');
let insideInterval = false;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('scheduleServerInterval(() => {')) {
        lines[i] = lines[i].replace('scheduleServerInterval(() => {', 'scheduleServerInterval(() => { try {');
        insideInterval = true;
    } else if (insideInterval && lines[i].match(/^\s*\}, \w+\);/)) {
        lines[i] = lines[i].replace('}, ', '} catch (e) { console.error("Tick error:", e); } }, ');
        insideInterval = false;
    }
}
c = lines.join('\n');

// 3. Fix Regen per sec intervals from 10000 -> 1000 (1 second)
c = c.replace('}, 10000);', '}, 1000);');
// NOTE: With the above regex, it will be `} catch (e) { ... } }, 10000);`, so we replace that:
c = c.replace('} catch (e) { console.error("Tick error:", e); } }, 10000);', '} catch (e) { console.error("Tick error:", e); } }, 1000);');

fs.writeFileSync('server/server.js', c);
