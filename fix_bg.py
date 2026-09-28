import os
from PIL import Image

def fix_bg(filename):
    path = os.path.join('client', 'assets', filename)
    if not os.path.exists(path):
        return
    img = Image.open(path).convert("RGBA")
    datas = img.getdata()
    newData = []
    
    # Replace solid black/very dark background or white background with magenta
    for item in datas:
        # Check if it's very dark (almost black) or very bright (almost white)
        is_dark = item[0] < 15 and item[1] < 15 and item[2] < 15
        is_light = item[0] > 240 and item[1] > 240 and item[2] > 240
        if is_dark or is_light:
            newData.append((255, 0, 255, 255))
        else:
            newData.append(item)
            
    img.putdata(newData)
    img.convert("RGB").save(path)
    print(f"Fixed background for {filename}")

fix_bg("merchant_sprite.jpg")
fix_bg("banker_sprite.jpg")
