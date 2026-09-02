import sys
from PIL import Image

def process_image(input_path, output_path, bg_color):
    img = Image.open(input_path).convert("RGBA")
    
    # Create a new square image with the background color
    size = max(img.width, img.height)
    if size != 1024:
        size = 1024
        
    # Scale img down if necessary, but here width is 1024, height is 795
    # So we don't need to resize, just paste it into the center of a 1024x1024 square
    new_img = Image.new("RGBA", (1024, 1024), bg_color)
    
    # Calculate position to center the image
    x = (1024 - img.width) // 2
    y = (1024 - img.height) // 2
    
    # Paste using alpha channel as mask
    new_img.paste(img, (x, y), img)
    
    # Convert to RGB (remove alpha, required for App Store)
    new_img = new_img.convert("RGB")
    new_img.save(output_path, "PNG")
    print(f"Saved {output_path}")

process_image('/Users/jay/.gemini/antigravity/brain/7dae2d1d-9e7c-4b7a-a593-2e65ef8e61bc/.user_uploaded/media_1788299150527.png', 'ios/Assets.xcassets/AppIcon.appiconset/icon-1024.png', (0, 0, 0))
