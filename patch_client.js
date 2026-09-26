const fs = require('fs');
let content = fs.readFileSync('client/test_client.html', 'utf8');
content = content.replace(
    'let myGold = 0;',
    'let authToken = null;\n        let myGold = 0;'
);
content = content.replace(
    'else if (data.action === \"auth_success\") {\n                document.getElementById(\"auth-modal\").style.display = \"none\";\n                document.getElementById(\"class-modal\").style.display = \"block\";\n                document.getElementById(\"char-name\").value = data.username || \"\";\n                document.getElementById(\"char-name\").readOnly = true;\n            }',
    'else if (data.action === \"auth_success\") {\n                authToken = data.token;\n                document.getElementById(\"auth-modal\").style.display = \"none\";\n                document.getElementById(\"class-modal\").style.display = \"block\";\n                if (data.account && data.account.username) {\n                    document.getElementById(\"char-name\").value = data.account.username;\n                    document.getElementById(\"char-name\").readOnly = true;\n                }\n            }'
);
content = content.replace(
    'socket.send(JSON.stringify({ action: type, username: user, password: pass }));',
    'socket.send(JSON.stringify({ action: \"auth_\" + type, username: user, password: pass }));'
);
content = content.replace(
    'socket.send(JSON.stringify({ action: \"login\", class: cls, name: name, warmode: warmode }));',
    'socket.send(JSON.stringify({ action: \"login\", class: cls, name: name, warmode: warmode, authToken: authToken }));'
);
fs.writeFileSync('client/test_client.html', content);
