import re

with open('ios/App/BotAvatarView.swift', 'r') as f:
    content = f.read()

# Replace hardcoded Circle() with dynamic mask
replacement = """    private var crop: AvatarCrop { room.avatarCrop ?? .circle }
    
    private var mask: AnyShape {
        switch crop {
        case .circle: AnyShape(Circle())
        case .rounded: AnyShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        case .square, .mascot: AnyShape(Rectangle())
        }
    }

    var body: some View {
        Group {
            if room.avatarUrl != nil, !failed, let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(mask)"""

content = re.sub(r'    var body: some View \{\n        Group \{\n            if room\.avatarUrl != nil, !failed, let image \{\n                Image\(uiImage: image\)\n                    \.resizable\(\)\n                    \.scaledToFill\(\)\n                    \.frame\(width: size, height: size\)\n                    \.clipShape\(Circle\(\)\)', replacement, content)

with open('ios/App/BotAvatarView.swift', 'w') as f:
    f.write(content)
