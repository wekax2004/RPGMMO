const fs = require('fs');
let content = fs.readFileSync('client/test_client.html', 'utf8');

// Add HTML for chat tabs
content = content.replace(
    '<div id="chat-container">',
    '<div id="chat-container">\n        <div id="chat-tabs" style="display:flex; background:rgba(0,0,0,0.8); font-size:12px; font-weight:bold; cursor:pointer; border-bottom:1px solid #444;">\n            <div class="chat-tab active" onclick="setChatTab(\\'all\\')" id="tab-all" style="padding:5px 10px; color:#fff;">All</div>\n            <div class="chat-tab" onclick="setChatTab(\\'global\\')" id="tab-global" style="padding:5px 10px; color:#aaa;">Global</div>\n            <div class="chat-tab" onclick="setChatTab(\\'zone\\')" id="tab-zone" style="padding:5px 10px; color:#aaa;">Zone</div>\n            <div class="chat-tab" onclick="setChatTab(\\'party\\')" id="tab-party" style="padding:5px 10px; color:#aaa;">Party</div>\n            <div class="chat-tab" onclick="setChatTab(\\'system\\')" id="tab-system" style="padding:5px 10px; color:#aaa;">System</div>\n        </div>'
);

// Add state variables
content = content.replace(
    'let myInventoryData = [];',
    'let myInventoryData = [];\n        let chatMessages = [];\n        let activeChatTab = "all";'
);

// Add JS for setChatTab and update addLog
const addLogFunc = unction setChatTab(tab) {
            activeChatTab = tab;
            ["all", "global", "zone", "party", "system"].forEach(t => {
                document.getElementById("tab-" + t).style.color = (t === tab) ? "#fff" : "#aaa";
                document.getElementById("tab-" + t).style.borderBottom = (t === tab) ? "2px solid #3b82f6" : "none";
            });
            renderChat();
        }

        function renderChat() {
            const c = document.getElementById("log-container");
            c.innerHTML = "";
            chatMessages.forEach(msg => {
                if (activeChatTab === "all" || msg.channel === activeChatTab || (activeChatTab==="system" && msg.channel==="system")) {
                    const d = document.createElement("div");
                    d.innerText = msg.text;
                    d.style.color = msg.color;
                    c.appendChild(d);
                }
            });
            c.scrollTop = c.scrollHeight;
        }

        function addLog(msg, channel="system") {
            let color = "#fff";
            if(msg.includes("DIED") || msg.includes("slain")) color = "#ff4444";
            else if(msg.includes("Gold") || msg.includes("XP")) color = "#ffd700";
            else if(msg.includes("QUEST")) color = "#ffcc44";
            else if(msg.includes("Equipped")) color = "#aaffaa";
            else if(channel === "party" || msg.startsWith("[Party]")) { color = "#00ff00"; channel = "party"; }
            else if(channel === "zone" || msg.startsWith("[Zone]")) { color = "#00ffff"; channel = "zone"; }
            else if(channel === "global") { color = "#ffffff"; }
            
            chatMessages.push({ text: msg, channel: channel, color: color });
            if (chatMessages.length > 200) chatMessages.shift(); // Max 200 messages
            renderChat();
        };

content = content.replace(/function addLog\(msg\) \{[\s\S]*?c\.scrollTop = c\.scrollHeight;\s*\}/, addLogFunc);

// Update chat socket handler
content = content.replace(
    'const channelLabel = data.channel === "party" ? "[Party]" : data.channel === "zone" ? "[Zone]" : "[Global]";\n                addLog(channelLabel + " " + (data.sender || data.name || "Player") + ": " + (data.text || ""));',
    'const channelLabel = data.channel === "party" ? "[Party]" : data.channel === "zone" ? "[Zone]" : "[Global]";\n                addLog(channelLabel + " " + (data.sender || data.name || "Player") + ": " + (data.text || ""), data.channel);'
);

fs.writeFileSync('client/test_client.html', content);
