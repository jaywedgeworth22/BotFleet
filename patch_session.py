import re
with open('ios/App/Session.swift', 'r') as f:
    content = f.read()

# Replace hardcoded .circle in updateRoomAvatar
content = re.sub(
    r'let patch = RoomPatch\(avatarUrl: urlVal, avatarCrop: \.circle\)',
    r'let currentCrop = state.rooms.first(where: { $0.id == id })?.avatarCrop ?? .circle\n            let patch = RoomPatch(avatarUrl: urlVal, avatarCrop: currentCrop)',
    content
)

with open('ios/App/Session.swift', 'w') as f:
    f.write(content)
