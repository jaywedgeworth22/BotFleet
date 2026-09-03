import sys
from PIL import Image

def analyze(img_path):
    img = Image.open(img_path)
    print(f"Size: {img.size}")
    
analyze("/Users/jay/.gemini/antigravity/brain/7dae2d1d-9e7c-4b7a-a593-2e65ef8e61bc/.user_uploaded/media_1788371815352.png")
