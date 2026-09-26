const fs = require('fs');
let c = fs.readFileSync('client/test_client.html', 'utf8');

const newCSS = `
        /* Pristine Equipment Paperdoll */
        .paperdoll {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            grid-template-rows: 1fr 1fr 1fr 1fr;
            gap: 6px;
            margin-bottom: 15px;
            background: rgba(0, 0, 0, 0.2);
            padding: 10px;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .eq-slot {
            background: rgba(30, 41, 59, 0.9);
            border: 1px solid rgba(129, 140, 248, 0.3);
            border-radius: 8px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 45px;
            font-size: 10px;
            cursor: pointer;
            transition: all 0.2s ease;
            text-align: center;
            box-shadow: inset 0 2px 5px rgba(0,0,0,0.5);
            color: #94a3b8;
        }
        .eq-slot:hover {
            border-color: #818cf8;
            background: rgba(51, 65, 85, 1);
            transform: scale(1.05);
        }
        .eq-slot.filled {
            color: #fbbf24;
            font-weight: bold;
            border-color: #fbbf24;
            text-shadow: 0 0 5px rgba(251, 191, 36, 0.3);
        }
        .eq-amulet { grid-column: 1; grid-row: 1; }
        .eq-helmet { grid-column: 2; grid-row: 1; }
        .eq-empty { grid-column: 3; grid-row: 1; opacity:0; pointer-events:none; }
        
        .eq-weapon { grid-column: 1; grid-row: 2; }
        .eq-armor { grid-column: 2; grid-row: 2; }
        .eq-shield { grid-column: 3; grid-row: 2; }
        
        .eq-ring1 { grid-column: 1; grid-row: 3; opacity:0; pointer-events:none; }
        .eq-legs { grid-column: 2; grid-row: 3; }
        .eq-ring2 { grid-column: 3; grid-row: 3; opacity:0; pointer-events:none; }
        
        .eq-boots { grid-column: 2; grid-row: 4; }

        /* Grid Inventory */
        .inv-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
            max-height: 160px;
            overflow-y: auto;
            padding: 5px;
        }
        .inv-cell {
            background: rgba(30, 41, 59, 0.8);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 6px;
            height: 40px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            font-size: 9px;
            cursor: pointer;
            transition: all 0.2s;
            position: relative;
            text-align: center;
            color: #e2e8f0;
            overflow: hidden;
        }
        .inv-cell:hover {
            background: rgba(51, 65, 85, 1);
            border-color: rgba(255, 255, 255, 0.3);
            transform: scale(1.05);
        }
        .inv-count {
            position: absolute;
            bottom: 2px; right: 4px;
            font-size: 8px;
            color: #fbbf24;
            font-weight: bold;
        }
`;

if (!c.includes('.paperdoll {')) {
    c = c.replace('</style>', newCSS + '\n    </style>');
}

// 2. Replace HTML
const htmlStart = '<div class="panel-box">\n                <h4>🎒 Equipment</h4>';
const htmlEnd = '<em style="color:#666">Empty</em>\n                </div>\n            </div>';

if (c.includes('<h4>🎒 Equipment</h4>')) {
    const startIndex = c.indexOf(htmlStart);
    const endIndex = c.indexOf(htmlEnd) + htmlEnd.length;
    
    if (startIndex !== -1 && endIndex !== -1) {
        const newHTML = `
            <div class="panel-box">
                <h4>🛡️ Equipment</h4>
                <div class="paperdoll">
                    <div id="eq-amulet" class="eq-slot eq-amulet" onclick="unequip('amulet')">Amulet</div>
                    <div id="eq-helmet" class="eq-slot eq-helmet" onclick="unequip('helmet')">Helmet</div>
                    <div class="eq-empty"></div>
                    
                    <div id="eq-weapon" class="eq-slot eq-weapon" onclick="unequip('weapon')">Weapon</div>
                    <div id="eq-armor" class="eq-slot eq-armor" onclick="unequip('armor')">Armor</div>
                    <div id="eq-shield" class="eq-slot eq-shield" onclick="unequip('shield')">Shield</div>
                    
                    <div class="eq-ring1"></div>
                    <div id="eq-legs" class="eq-slot eq-legs" onclick="unequip('legs')">Legs</div>
                    <div class="eq-ring2"></div>
                    
                    <div id="eq-boots" class="eq-slot eq-boots" onclick="unequip('boots')">Boots</div>
                </div>
            </div>
            
            <div class="panel-box" style="flex:1">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <h4>🎒 Bag</h4>
                    <span style="font-size:12px; color:#fbbf24; font-weight:bold; margin-bottom:10px;">🪙 <span id="gold-val">0</span></span>
                </div>
                <div id="inventory-list" class="inv-grid">
                    <!-- filled dynamically -->
                </div>
            </div>`;
        c = c.substring(0, startIndex) + newHTML + c.substring(endIndex);
    }
}

// 3. Replace Equipment JS rendering
const jsOldEquip = `                if (data.equipment) {
                    document.getElementById("equip-helmet").innerText = "Helmet: " + (data.equipment.helmet || "None");
                    document.getElementById("equip-amulet").innerText = "Amulet: " + (data.equipment.amulet || "None");
                    document.getElementById("equip-weapon").innerText = "Weapon: " + (data.equipment.weapon || "None");
                    document.getElementById("equip-shield").innerText = "Shield: " + (data.equipment.shield || "None");
                    document.getElementById("equip-armor").innerText = "Armor: " + (data.equipment.armor || "None");
                    document.getElementById("equip-legs").innerText = "Legs: " + (data.equipment.legs || "None");
                    document.getElementById("equip-boots").innerText = "Boots: " + (data.equipment.boots || "None");
                }`;
const jsNewEquip = `                if (data.equipment) {
                    const slots = ['helmet', 'amulet', 'weapon', 'shield', 'armor', 'legs', 'boots'];
                    slots.forEach(slot => {
                        const el = document.getElementById("eq-" + slot);
                        if (el) {
                            if (data.equipment[slot]) {
                                el.innerText = data.equipment[slot];
                                el.classList.add("filled");
                            } else {
                                el.innerText = slot.charAt(0).toUpperCase() + slot.slice(1);
                                el.classList.remove("filled");
                            }
                        }
                    });
                }`;

if (c.includes('document.getElementById("equip-helmet").innerText')) {
    c = c.replace(jsOldEquip, jsNewEquip);
}

// 4. Replace Inventory JS rendering
const jsOldInv = `                    invEl.innerHTML = Object.keys(counts).map(k => 
                        "<div class='inv-item' style='cursor:pointer' onclick='clickItem(\\"" + escapeHtml(k).replace(/'/g, "&#39;") + "\\")' title='Click to equip/use'>" + escapeHtml(k) + " x" + counts[k] + "</div>"
                    ).join("");`;

const jsNewInv = `                    invEl.innerHTML = Object.keys(counts).map(k => {
                        const safeName = escapeHtml(k).replace(/'/g, "&#39;");
                        let shortName = k;
                        if (shortName.length > 15) shortName = shortName.substring(0, 13) + "..";
                        return "<div class='inv-cell' onclick='clickItem(\\"" + safeName + "\\")' title='" + escapeHtml(k) + "'>" 
                            + "<span>" + shortName + "</span>" 
                            + (counts[k] > 1 ? "<div class='inv-count'>" + counts[k] + "</div>" : "")
                            + "</div>";
                    }).join("");
                    
                    const emptySlots = Math.max(0, 16 - Object.keys(counts).length);
                    for(let i=0; i<emptySlots; i++) {
                        invEl.innerHTML += "<div class='inv-cell' style='background:rgba(0,0,0,0.1); border-color:transparent; cursor:default;'></div>";
                    }`;

if (c.includes("class='inv-item'")) {
    c = c.replace(jsOldInv, jsNewInv);
}

fs.writeFileSync('client/test_client.html', c);
