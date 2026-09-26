const fs = require('fs');
let c = fs.readFileSync('client/test_client.html', 'utf8');

c = c.replace('const SPRITE_BASE = "/assets/rpg-import/";', 'const SPRITE_BASE = "/assets/";');

const oldSpriteFiles = `        const SPRITE_FILES = {
            warrior: "sprites/knight.png"
        };`;

const newSpriteFiles = `        const SPRITE_FILES = {
            warrior: "warrior.jpg",
            mage: "mage.jpg",
            ranger: "ranger.jpg",
            healer: "healer.jpg"
        };`;

c = c.replace(oldSpriteFiles, newSpriteFiles);

const oldOpDraw = `const opSprite = op.classType === "warrior" ? getSprite("warrior") : null;`;
const newOpDraw = `const opSprite = getSprite(op.classType);`;
c = c.replace(oldOpDraw, newOpDraw);

const oldMyDraw = `const mySprite = player.classType === "warrior" ? getSprite("warrior") : null;`;
const newMyDraw = `const mySprite = getSprite(player.classType);`;
c = c.replace(oldMyDraw, newMyDraw);

fs.writeFileSync('client/test_client.html', c);
