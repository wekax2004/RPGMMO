import os
from PIL import Image

def stitch_sprites(prefix, start, end, out_name):
    base_dir = r"C:\Users\home\.gemini\antigravity\scratch\tibia_mmo\client\assets\extracted_sprites"
    out_dir = r"C:\Users\home\.gemini\antigravity\scratch\tibia_mmo\client\assets"
    
    images = []
    for i in range(start, end + 1):
        filename = f"{prefix}_{i}.png"
        path = os.path.join(base_dir, filename)
        if os.path.exists(path):
            images.append(Image.open(path))
            
    if not images:
        print(f"No images found for {prefix} {start}-{end}")
        return
        
    width = sum(img.width for img in images)
    height = max(img.height for img in images)
    
    stitched = Image.new('RGBA', (width, height))
    x_offset = 0
    for img in images:
        stitched.paste(img, (x_offset, 0))
        x_offset += img.width
        
    out_path = os.path.join(out_dir, out_name)
    stitched.save(out_path)
    print(f"Saved stitched image to {out_path}")

if __name__ == "__main__":
    stitch_sprites("s2", 26, 39, "orc_warlord_sheet.png")
    stitch_sprites("s3", 27, 43, "cave_sheet.png")
    
    # Also save the first frame as a static image for easy loading
    stitch_sprites("s2", 26, 26, "orc_warlord.png")
    stitch_sprites("s3", 27, 27, "cave.png")
