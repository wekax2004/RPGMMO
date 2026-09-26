const fs = require('fs');
let content = fs.readFileSync('client/test_client.html', 'utf8');

// 1. Fix quest indicator and escape o.text
content = content.replace(
    'q.objectives.forEach(o => { html += "<div style=\\"font-size:11px; color:" + (o.done ? "#44ff44" : "#ccc") + "\\">" + (o.done ? "?" : "?") + " " + o.text + " " + o.progress + "</div>"; });',
    'q.objectives.forEach(o => { html += "<div style=\\"font-size:11px; color:" + (o.done ? "#44ff44" : "#ccc") + "\\">" + (o.done ? "?" : "?") + " " + escapeHtml(o.text) + " " + escapeHtml(String(o.progress)) + "</div>"; });'
);

// 2. Escape item in renderShopSellList
content = content.replace(
    'sellHtml += "<div style=\'display:flex; justify-content:space-between; margin-bottom:5px;\'><span>" + item + " x" + counts[item] + "</span><button onclick=\'shopSell(\\"" + item + "\\")\' style=\'background:#aa4444; border:none; color:white; padding:2px 5px; cursor:pointer\'>Sell</button></div>";',
    'sellHtml += "<div style=\'display:flex; justify-content:space-between; margin-bottom:5px;\'><span>" + escapeHtml(item) + " x" + counts[item] + "</span><button onclick=\'shopSell(\\"" + escapeHtml(item) + "\\")\' style=\'background:#aa4444; border:none; color:white; padding:2px 5px; cursor:pointer\'>Sell</button></div>";'
);

// 3. Escape subclass card injection
content = content.replace(
    'html += "<div id=\'subclass-card-" + id + "\' class=\'class-card subclass-card\' onclick=\'selectSubclass(\\"" + id + "\\")\'><h3 style=\'color:#00aaff; margin:0\'>" + name + "</h3><p style=\'font-size:10px;color:#aaa\'>" + description + "</p></div>";',
    'html += "<div id=\'subclass-card-" + escapeHtml(id) + "\' class=\'class-card subclass-card\' onclick=\'selectSubclass(\\"" + escapeHtml(id) + "\\")\'><h3 style=\'color:#00aaff; margin:0\'>" + escapeHtml(name) + "</h3><p style=\'font-size:10px;color:#aaa\'>" + escapeHtml(description) + "</p></div>";'
);

// 4. Remove redundant replace in myEquipData
content = content.replace(
    'eqHtml += "<div style=\'background:#222; padding:5px; margin-bottom:5px; font-size:12px\'><strong style=\'color:#ccc\'>" + escapeHtml(k).replace(/\\'/g,"&#39;") + ":</strong> " + escapeHtml(myEquipData[k]) + "</div>";',
    'eqHtml += "<div style=\'background:#222; padding:5px; margin-bottom:5px; font-size:12px\'><strong style=\'color:#ccc\'>" + escapeHtml(k) + ":</strong> " + escapeHtml(myEquipData[k]) + "</div>";'
);

fs.writeFileSync('client/test_client.html', content);
