import os
from PIL import Image

def remove_background(filepath, output_path):
    print(f"Processing {filepath}...")
    img = Image.open(filepath).convert("RGBA")
    data = img.getdata()
    
    # Get the background color from the top-left pixel
    bg_color = data[0]
    
    new_data = []
    # Threshold for color matching
    threshold = 30
    
    for item in data:
        # Check if the pixel color is close to the background color
        if (abs(item[0] - bg_color[0]) < threshold and 
            abs(item[1] - bg_color[1]) < threshold and 
            abs(item[2] - bg_color[2]) < threshold):
            # Replace with transparent
            new_data.append((255, 255, 255, 0))
        else:
            new_data.append(item)
            
    img.putdata(new_data)
    img.save(output_path, "PNG")
    print(f"Saved to {output_path}")

# Run on the 3 NPC images
if __name__ == "__main__":
    assets_dir = "c:\\Users\\home\\.gemini\\antigravity\\scratch\\tibia_mmo\\client\\assets"
    
    files_to_fix = [
        "npc_aria_sprite.jpg",
        "merchant_sprite.jpg",
        "banker_sprite.jpg",
        "king_arthur_sprite.jpg",
        "npc_sprite.jpg",
        "npc_2_magenta_1790579483384.jpg"
    ]
    
    for f in files_to_fix:
        input_path = os.path.join(assets_dir, f)
        output_path = os.path.join(assets_dir, f.replace(".jpg", ".png"))
        if os.path.exists(input_path):
            remove_background(input_path, output_path)
        else:
            print(f"File not found: {input_path}")
