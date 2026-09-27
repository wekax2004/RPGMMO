import os
from rembg import remove
from PIL import Image

assets_dir = "client/assets"
images = ["warrior.jpg", "mage.jpg", "ranger.jpg", "healer.jpg"]

for img_name in images:
    img_path = os.path.join(assets_dir, img_name)
    if not os.path.exists(img_path):
        continue
    
    input_img = Image.open(img_path)
    # Use rembg to perfectly isolate the character and remove everything else
    output_img = remove(input_img)
    
    new_name = img_name.replace(".jpg", ".png")
    output_path = os.path.join(assets_dir, new_name)
    output_img.save(output_path, "PNG")
    print(f"Perfectly removed background for {img_name}")
