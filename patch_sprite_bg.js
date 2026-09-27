const fs = require('fs');
let c = fs.readFileSync('client/test_client.html', 'utf8');

// 1. Patch the sprite onload to add Chromakey (Background Removal)
const oldSpriteLoad = `        Object.keys(SPRITE_FILES).forEach(key => {
            const img = new Image();
            const entry = { image: img, ready: false };
            loadedSprites[key] = entry;
            img.onload = () => { entry.ready = true; };
            img.onerror = () => { entry.ready = false; };
            img.src = SPRITE_BASE + SPRITE_FILES[key];
        });`;

const newSpriteLoad = `        Object.keys(SPRITE_FILES).forEach(key => {
            const img = new Image();
            const entry = { image: null, ready: false };
            loadedSprites[key] = entry;
            img.onload = () => { 
                // Create offscreen canvas to process transparency
                const cCanvas = document.createElement("canvas");
                cCanvas.width = img.width;
                cCanvas.height = img.height;
                const cCtx = cCanvas.getContext("2d");
                cCtx.drawImage(img, 0, 0);
                
                // Chromakey: Remove the background (Checkered or White)
                try {
                    const imgData = cCtx.getImageData(0, 0, cCanvas.width, cCanvas.height);
                    const data = imgData.data;
                    
                    // Sample corners to find background colors
                    const bgColors = [];
                    const addBgColor = (x, y) => {
                        const idx = (y * cCanvas.width + x) * 4;
                        if (data[idx+3] > 0) bgColors.push({ r: data[idx], g: data[idx+1], b: data[idx+2] });
                    };
                    addBgColor(0, 0);
                    addBgColor(1, 0); // In case of checkerboard
                    
                    const tolerance = 25;
                    for (let i = 0; i < data.length; i += 4) {
                        for (let bg of bgColors) {
                            if (Math.abs(data[i] - bg.r) < tolerance &&
                                Math.abs(data[i+1] - bg.g) < tolerance &&
                                Math.abs(data[i+2] - bg.b) < tolerance &&
                                // Don't delete dark pixels (outline)
                                data[i] > 100) {
                                data[i+3] = 0; // Transparent
                                break;
                            }
                        }
                    }
                    cCtx.putImageData(imgData, 0, 0);
                } catch(e) { console.error(e); }
                
                entry.image = cCanvas; // Use processed canvas as sprite
                entry.ready = true; 
            };
            img.onerror = () => { entry.ready = false; };
            img.src = SPRITE_BASE + SPRITE_FILES[key];
        });`;

if (c.includes('img.onload = () => { entry.ready = true; };')) {
    c = c.replace(oldSpriteLoad, newSpriteLoad);
}

// 2. Patch drawing size to make it bigger (from 32x32 to 48x48)
const oldOpDraw = `                if (opSprite) {
                    ctx.drawImage(opSprite, op.renderX, op.renderY, 32, 32);
                }`;
const newOpDraw = `                if (opSprite) {
                    ctx.drawImage(opSprite, op.renderX - 8, op.renderY - 16, 48, 48);
                }`;
c = c.replace(oldOpDraw, newOpDraw);

const oldMyDraw = `            if (mySprite) {
                ctx.drawImage(mySprite, player.x, player.y, 32, 32);
            }`;
const newMyDraw = `            if (mySprite) {
                ctx.drawImage(mySprite, player.x - 8, player.y - 16, 48, 48);
            }`;
c = c.replace(oldMyDraw, newMyDraw);

fs.writeFileSync('client/test_client.html', c);
