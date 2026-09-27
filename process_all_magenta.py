import os
import shutil
import glob
from PIL import Image

brain_dir = r"C:\Users\home\.gemini\antigravity-ide\brain\02721839-622a-45a8-abac-4dade653d65d"
assets_dir = r"c:\Users\home\.gemini\antigravity\scratch\tibia_mmo\client\assets"

# Find all _magenta_*.jpg files
files = glob.glob(os.path.join(brain_dir, "*_magenta_*.jpg"))

def process_magenta(img_path, output_name):
    img = Image.open(img_path).convert("RGBA")
    datas = img.getdata()
    newData = []
    
    tolerance = 80 
    target = (255, 0, 255)
    
    for item in datas:
        if abs(item[0] - target[0]) < tolerance and item[1] < tolerance and abs(item[2] - target[2]) < tolerance:
            newData.append((255, 255, 255, 0)) # Transparent
        else:
            newData.append(item)
            
    img.putdata(newData)
    
    output_path = os.path.join(assets_dir, output_name)
    img.save(output_path, "PNG")
    print(f"Processed {os.path.basename(img_path)} -> {output_name}")

for file in files:
    # e.g. warrior_magenta_123123.jpg -> warrior.png
    base = os.path.basename(file)
    name = base.split("_magenta_")[0] + ".png"
    process_magenta(file, name)

print("Done processing all magenta sprites.")
