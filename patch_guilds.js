const fs = require('fs');

// Patch server.js
let s = fs.readFileSync('server/server.js', 'utf8');

if (!s.includes('const GUILDS = require("./guilds");')) {
    s = s.replace(
        'const { chests, spawnChest } = require("./chests");',
        'const { chests, spawnChest } = require("./chests");\nconst GUILDS = require("./guilds");'
    );
    
    // add getPlayerByName
    const getP = `function getPlayerByName(name) {\n    for (let p of players.values()) {\n        if (p.charName === name) return p;\n    }\n    return null;\n}\n\nmodule.exports.getPlayerByName = getPlayerByName;\nmodule.exports.broadcast = broadcast;\nmodule.exports.sendTo = sendTo;\n`;
    s = s.replace('module.exports = {', getP + 'module.exports = {');
}

// Add chat commands
if (!s.includes('if (data.action === "chat")')) {
    // it's 'chat' not "chat"
    s = s.replace(
        "if (data.action === 'chat') {",
        `if (data.action === 'chat') {
                if (data.text.startsWith('/guild create ')) { GUILDS.createGuild(player, data.text.substring(14).trim()); return; }
                if (data.text.startsWith('/guild invite ')) { GUILDS.inviteGuild(player, data.text.substring(14).trim()); return; }
                if (data.text === '/guild accept') { GUILDS.acceptGuild(player); return; }
                if (data.text.startsWith('/guild kick ')) { GUILDS.kickGuild(player, data.text.substring(12).trim()); return; }
                if (data.text === '/guild leave') { GUILDS.leaveGuild(player); return; }
                if (data.channel === 'guild' || data.text.startsWith('/g ')) { 
                    if (!player.guild) return sendTo(player, { action: 'log', message: 'You are not in a guild.' });
                    const txt = data.text.startsWith('/g ') ? data.text.substring(3) : data.text;
                    GUILDS.broadcastGuild(GUILDS.guilds.get(player.guild), txt, player.charName); 
                    return; 
                }`
    );
}

fs.writeFileSync('server/server.js', s);

// Patch test_client.html
let c = fs.readFileSync('client/test_client.html', 'utf8');

if (!c.includes('guild_sync')) {
    c = c.replace(
        'let pendingPartyInvite = null;',
        'let pendingPartyInvite = null;\n        let myGuild = null;'
    );
    
    c = c.replace(
        'else if (data.action === "party_update" || data.action === "party_sync") {',
        `else if (data.action === "guild_sync") {
                myGuild = data.guild;
                const gList = document.getElementById("guild-list");
                if (!myGuild) { gList.innerHTML = "<em style='color:#666'>No Guild</em>"; }
                else {
                    let h = "<b>" + escapeHtml(myGuild.name) + "</b><br/>Leader: " + escapeHtml(myGuild.leader) + "<br/>Members:<br/>";
                    myGuild.members.forEach(m => h += "- " + escapeHtml(m) + "<br/>");
                    gList.innerHTML = h;
                }
            }
            else if (data.action === "party_update" || data.action === "party_sync") {`
    );
    
    // Add guild-list UI element
    c = c.replace(
        '<div id="party-list"><em style="color:#666">No Party</em></div>\n            </div>',
        `<div id="party-list"><em style="color:#666">No Party</em></div>
            </div>
            <div class="panel-box">
                <h4>🛡️ Guild</h4>
                <div id="guild-list"><em style="color:#666">No Guild</em></div>
            </div>`
    );
    
    // Add tab for Guild
    c = c.replace(
        '<div onclick="setChatTab(\\'party\\')" id="tab-party"',
        `<div onclick="setChatTab('guild')" id="tab-guild" style="flex:1; text-align:center; padding:4px; color:#aaa;">Guild</div>
                    <div onclick="setChatTab('party')" id="tab-party"`
    );
    
    c = c.replace(
        '["all", "global", "zone", "party", "system"].forEach(t => {',
        '["all", "global", "zone", "party", "guild", "system"].forEach(t => {'
    );
    
    c = c.replace(
        'else if(channel === "party" || msg.startsWith("[Party]")) { color = "#00ff00"; channel = "party"; }',
        'else if(channel === "guild" || msg.startsWith("[Guild]")) { color = "#ff8800"; channel = "guild"; }\n            else if(channel === "party" || msg.startsWith("[Party]")) { color = "#00ff00"; channel = "party"; }'
    );
}

fs.writeFileSync('client/test_client.html', c);

