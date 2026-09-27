const fs = require('fs');
let c = fs.readFileSync('client/test_client.html', 'utf8');

const oldSpriteLoad = `        const SPRITE_FILES = {
            warrior: "warrior.jpg",
            mage: "mage.jpg",
            ranger: "ranger.jpg",
            healer: "healer.jpg"
        };
        const loadedSprites = {};
        Object.keys(SPRITE_FILES).forEach(key => {
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

const newSpriteLoad = `        const SPRITE_FILES = {
            warrior: "warrior.png",
            mage: "mage.png",
            ranger: "ranger.png",
            healer: "healer.png"
        };
        const loadedSprites = {};
        Object.keys(SPRITE_FILES).forEach(key => {
            const img = new Image();
            const entry = { image: img, ready: false };
            loadedSprites[key] = entry;
            img.onload = () => { entry.ready = true; };
            img.onerror = () => { entry.ready = false; };
            img.src = SPRITE_BASE + SPRITE_FILES[key];
        });`;

c = c.replace(oldSpriteLoad, newSpriteLoad);
fs.writeFileSync('client/test_client.html', c);
