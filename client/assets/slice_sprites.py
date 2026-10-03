import os
from PIL import Image

def slice_spritesheet(file_path, out_dir, prefix):
    if not os.path.exists(out_dir):
        os.makedirs(out_dir)
        
    try:
        img = Image.open(file_path)
    except Exception as e:
        print(f"Failed to open {file_path}: {e}")
        return

    width, height = img.size
    print(f"Processing {file_path} (size: {width}x{height})")
    
    tile_size = 32
    cols = width // tile_size
    rows = height // tile_size
    
    count = 0
    # Let's just extract the first 100 non-empty sprites to avoid making 100,000 files
    for r in range(rows):
        for c in range(cols):
            left = c * tile_size
            upper = r * tile_size
            right = left + tile_size
            lower = upper + tile_size
            
            box = (left, upper, right, lower)
            tile = img.crop(box)
            
            # Check if tile is not completely transparent/empty
            if tile.getbbox():
                tile.save(os.path.join(out_dir, f"{prefix}_{count}.png"))
                count += 1
                if count >= 100:
                    print(f"Extracted 100 sprites to {out_dir}")
                    return

if __name__ == "__main__":
    base_dir = r"C:\Users\home\.gemini\antigravity\scratch\tibia_mmo\client\assets\tibia-sprites\7.1"
    out_dir = r"C:\Users\home\.gemini\antigravity\scratch\tibia_mmo\client\assets\extracted_sprites"
    
    slice_spritesheet(os.path.join(base_dir, "Sprites-0.png"), out_dir, "s0")
    slice_spritesheet(os.path.join(base_dir, "Sprites-1.png"), out_dir, "s1")
    slice_spritesheet(os.path.join(base_dir, "Sprites-2.png"), out_dir, "s2")
    slice_spritesheet(os.path.join(base_dir, "Sprites-3.png"), out_dir, "s3")
