const fs = require('fs');
let content = fs.readFileSync('client/test_client.html', 'utf8');
content = content.replace(
    'addLog(channelLabel + " " + (data.sender || data.name || "Player") + ": " + (data.text || ""));',
    'addLog(channelLabel + " " + (data.sender || data.name || "Player") + ": " + (data.text || ""), data.channel || "global");'
);
fs.writeFileSync('client/test_client.html', content);
