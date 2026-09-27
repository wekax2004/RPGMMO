from PIL import Image
import os
from collections import Counter

assets_dir = "client/assets"
images = ["warrior.jpg", "mage.jpg", "ranger.jpg", "healer.jpg"]

def get_border_colors(img):
    datas = list(img.getdata())
    width, height = img.size
    border_pixels = []
    for x in range(width):
        border_pixels.append(datas[x]) # Top
        border_pixels.append(datas[(height-1)*width + x]) # Bottom
    for y in range(1, height-1):
        border_pixels.append(datas[y*width]) # Left
        border_pixels.append(datas[y*width + width - 1]) # Right
    
    # Find the two most common colors on the border
    counter = Counter(border_pixels)
    most_common = counter.most_common(2)
    return [color for color, count in most_common]

for img_name in images:
    img_path = os.path.join(assets_dir, img_name)
    if not os.path.exists(img_path):
        continue
    
    img = Image.open(img_path).convert("RGBA")
    datas = img.getdata()
    
    bg_colors = get_border_colors(img)
    
    newData = []
    tolerance = 45 # High tolerance for JPG compression artifacts
    
    for item in datas:
        is_bg = False
        for bg in bg_colors:
            if abs(item[0] - bg[0]) < tolerance and abs(item[1] - bg[1]) < tolerance and abs(item[2] - bg[2]) < tolerance:
                is_bg = True
                break
                
        # If it matches the background and isn't super dark (character outlines)
        if is_bg and item[0] > 80 and item[1] > 80 and item[2] > 80:
            newData.append((255, 255, 255, 0))
        else:
            newData.append(item)
            
    img.putdata(newData)
    
    new_name = img_name.replace(".jpg", ".png")
    output_path = os.path.join(assets_dir, new_name)
    img.save(output_path, "PNG")
    print(f"Removed checkerboard for {img_name}")
