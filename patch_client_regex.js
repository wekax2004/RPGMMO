const fs = require('fs');
let content = fs.readFileSync('client/test_client.html', 'utf8');
content = content.replace(
    'escapeHtml(k).replace(/\\\'/g, "&#39;")',
    'escapeHtml(k)'
);
fs.writeFileSync('client/test_client.html', content);
