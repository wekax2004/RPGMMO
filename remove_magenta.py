from PIL import Image
import os
import shutil

assets_dir = "client/assets"
images = ["warrior.jpg", "mage.jpg", "ranger.jpg", "healer.jpg", "spider.jpg", "dragon.jpg", "goblin.jpg", "skeleton.jpg", "yeti.jpg"]

def process_magenta(img_path):
    img = Image.open(img_path).convert("RGBA")
    datas = img.getdata()
    newData = []
    
    # Magenta is usually #FF00FF (255, 0, 255)
    # Since it's a JPG, it might have slight compression artifacts, so we use a very tight tolerance
    tolerance = 80 
    target = (255, 0, 255)
    
    for item in datas:
        # Distance to magenta
        if abs(item[0] - target[0]) < tolerance and item[1] < tolerance and abs(item[2] - target[2]) < tolerance:
            newData.append((255, 255, 255, 0)) # Transparent
        else:
            newData.append(item)
            
    img.putdata(newData)
    
    new_name = os.path.basename(img_path).replace(".jpg", ".png")
    output_path = os.path.join(assets_dir, new_name)
    img.save(output_path, "PNG")
    print(f"Removed magenta background for {new_name}")

# Just testing with the warrior_magenta file
test_file = r"C:\Users\home\.gemini\antigravity-ide\brain\02721839-622a-45a8-abac-4dade653d65d\warrior_magenta_1790447404090.jpg"
if os.path.exists(test_file):
    process_magenta(test_file)
