const fs = require('fs');
let c = fs.readFileSync('client/test_client.html', 'utf8');

// Update SPRITE_FILES
const oldSpriteLoad = `        const SPRITE_FILES = {
            warrior: "warrior.png",
            mage: "mage.png",
            ranger: "ranger.png",
            healer: "healer.png"
        };`;

const newSpriteLoad = `        const SPRITE_FILES = {
            warrior: "warrior.png",
            mage: "mage.png",
            ranger: "ranger.png",
            healer: "healer.png",
            spider: "spider.png",
            skeleton: "skeleton.png",
            goblin: "goblin.png",
            yeti: "yeti.png",
            dragon: "dragon.png"
        };`;

c = c.replace(oldSpriteLoad, newSpriteLoad);

// Update draw loop for mobs
const oldMobDraw = `                let emoji = "👾";
                if (m.type === "spider") emoji = isBoss ? "🕷️👑" : "🕷️";
                else if (m.type === "skeleton") emoji = isBoss ? "💀👑" : "💀";
                else if (m.type === "minotaur") emoji = "🐂";
                else if (m.type === "bear") emoji = "🐻";
                else if (m.type === "yeti") emoji = "⛄";
                else if (m.type === "dragon") emoji = "🐉"; 
                
                ctx.font = isBoss ? "40px Arial" : "28px Arial";
                ctx.fillText(emoji, drawX, drawY + size - 4);`;

const newMobDraw = `                // Map missing monsters to existing sprites temporarily
                let spriteKey = m.type;
                if (spriteKey === "minotaur") spriteKey = "goblin";
                if (spriteKey === "bear") spriteKey = "yeti";
                
                const mobSprite = getSprite(spriteKey);
                if (mobSprite) {
                    // Draw the image instead of an emoji
                    // Increase size if it's a boss
                    const renderSize = isBoss ? size * 1.5 : 32;
                    const offset = isBoss ? (renderSize - size) / 2 : 0;
                    ctx.drawImage(mobSprite, drawX - offset, drawY - offset, renderSize, renderSize);
                } else {
                    // Fallback just in case
                    ctx.font = isBoss ? "40px Arial" : "28px Arial";
                    ctx.fillText("👾", drawX, drawY + size - 4);
                }`;

c = c.replace(oldMobDraw, newMobDraw);
fs.writeFileSync('client/test_client.html', c);
