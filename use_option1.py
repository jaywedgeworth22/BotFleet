from PIL import Image

# Open the 1024x1024 black background image
img = Image.open('/Users/jay/.gemini/antigravity/brain/7dae2d1d-9e7c-4b7a-a593-2e65ef8e61bc/.user_uploaded/media_1788317721174.png')

# Convert to RGB to strip the alpha channel, satisfying App Store requirements
img_rgb = img.convert("RGB")

# Save to the AppIcon and DynamicIslandIcon locations
img_rgb.save('ios/Assets.xcassets/AppIcon.appiconset/icon-1024.png', 'PNG')
img_rgb.save('ios/Assets.xcassets/DynamicIslandIcon.imageset/icon@3x.png', 'PNG')
img_rgb.save('ios/Assets.xcassets/DynamicIslandIcon.imageset/icon@2x.png', 'PNG')
img_rgb.save('ios/Assets.xcassets/DynamicIslandIcon.imageset/icon.png', 'PNG')
