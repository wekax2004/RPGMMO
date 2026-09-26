const fs = require('fs');
let c = fs.readFileSync('client/test_client.html', 'utf8');

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

fs.writeFileSync('client/test_client.html', c);
