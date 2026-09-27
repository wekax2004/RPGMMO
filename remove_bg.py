from PIL import Image
import os

assets_dir = "client/assets"
images = ["warrior.jpg", "mage.jpg", "ranger.jpg", "healer.jpg"]

for img_name in images:
    img_path = os.path.join(assets_dir, img_name)
    if not os.path.exists(img_path):
        continue
    
    img = Image.open(img_path).convert("RGBA")
    datas = img.getdata()
    
    newData = []
    
    # We will sample the top-left pixel to determine the background color
    bg_color = datas[0]
    # In case of checkerboard, we might also want to sample 1 pixel over
    bg_color_2 = datas[1]
    
    tolerance = 40
    
    for item in datas:
        # Check if pixel is close to bg_color 1 or 2
        match1 = abs(item[0] - bg_color[0]) < tolerance and abs(item[1] - bg_color[1]) < tolerance and abs(item[2] - bg_color[2]) < tolerance
        match2 = abs(item[0] - bg_color_2[0]) < tolerance and abs(item[1] - bg_color_2[1]) < tolerance and abs(item[2] - bg_color_2[2]) < tolerance
        
        # If it's a light pixel and matches the background, make it transparent
        if (match1 or match2) and item[0] > 100:
            newData.append((255, 255, 255, 0))
        else:
            newData.append(item)
            
    img.putdata(newData)
    
    new_name = img_name.replace(".jpg", ".png")
    img.save(os.path.join(assets_dir, new_name), "PNG")
    print(f"Processed {img_name} -> {new_name}")
