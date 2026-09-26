const fs = require('fs');
let c = fs.readFileSync('client/test_client.html', 'utf8');

c = c.replace(
    'background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);',
    'background: radial-gradient(circle at 50% 0%, #2e285a 0%, #0f172a 100%);'
);

c = c.replace(
    'box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);',
    'box-shadow: 0 0 40px rgba(129, 140, 248, 0.3), 0 12px 40px rgba(0, 0, 0, 0.4);\n            border: 2px solid rgba(129, 140, 248, 0.15);'
);

c = c.replace(
    'h2 { font-family: \\'Outfit\\', sans-serif; font-size: 24px; margin: 4px 0 16px; color: #fff; text-shadow: 0 0 10px rgba(129, 140, 248, 0.5); }',
    'h2 { font-family: \\'Outfit\\', sans-serif; font-size: 28px; margin: 4px 0 16px; color: #fff; text-shadow: 0 0 15px rgba(129, 140, 248, 0.8); text-transform: uppercase; letter-spacing: 2px; }'
);

if (!c.includes('.modal { display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95); opacity: 0; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }')) {
    c = c.replace(
        '.modal { \n            display: none; \n            position: absolute; \n            top: 50%; left: 50%; \n            transform: translate(-50%, -50%); \n            background: rgba(15, 23, 42, 0.95); \n            backdrop-filter: blur(16px);\n            -webkit-backdrop-filter: blur(16px);\n            padding: 30px; \n            border: 1px solid rgba(255, 255, 255, 0.1); \n            border-radius: 16px; \n            z-index: 10; \n            text-align: center; \n            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255,255,255,0.1); \n        }',
        '.modal { \n            display: none; \n            position: absolute; \n            top: 50%; left: 50%; \n            transform: translate(-50%, -50%); \n            background: rgba(15, 23, 42, 0.95); \n            backdrop-filter: blur(16px);\n            -webkit-backdrop-filter: blur(16px);\n            padding: 30px; \n            border: 1px solid rgba(255, 255, 255, 0.1); \n            border-radius: 16px; \n            z-index: 10; \n            text-align: center; \n            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 30px rgba(129,140,248,0.3); \n        }\n        .modal.active { display: block; animation: modalPop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards; }\n        @keyframes modalPop { 0% { transform: translate(-50%, -50%) scale(0.9); opacity: 0; } 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; } }'
    );
}

// Add active class toggling in show functions
c = c.replace(
    'document.getElementById("auth-modal").style.display = "block";',
    'let a = document.getElementById("auth-modal"); a.style.display = "block"; a.classList.add("active");'
);
c = c.replace(
    'document.getElementById("class-modal").style.display = "block";',
    'let b = document.getElementById("class-modal"); b.style.display = "block"; b.classList.add("active");'
);
c = c.replace(
    'document.getElementById("subclass-modal").style.display = "block";',
    'let sub = document.getElementById("subclass-modal"); sub.style.display = "block"; sub.classList.add("active");'
);

c = c.replace(
    'function hideModals() {\n            document.getElementById("auth-modal").style.display = "none";',
    'function hideModals() {\n            document.querySelectorAll(".modal").forEach(m => { m.style.display="none"; m.classList.remove("active"); });'
);

// Better inputs
c = c.replace(
    '#chat-input:focus { border-color: #fbbf24; box-shadow: 0 0 10px rgba(251, 191, 36, 0.2); background: rgba(30, 41, 59, 0.9);}',
    '#chat-input:focus { border-color: #818cf8; box-shadow: 0 0 15px rgba(129, 140, 248, 0.4); background: rgba(30, 41, 59, 0.9);}'
);


fs.writeFileSync('client/test_client.html', c);
