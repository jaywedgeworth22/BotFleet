with open('ios/App/Session.swift', 'r') as f:
    content = f.read()

content = content.replace(
    'func updateRoom(id: String, name: String?, bulletin: String?, avatarCrop: AvatarCrop?) async {',
    'func updateRoom(id: String, name: String?, bulletin: String?, avatarCrop: AvatarCrop?, cwd: String? = nil, extraCwds: [String]? = nil) async {'
)

content = content.replace(
    'let patch = RoomPatch(name: name, bulletin: bulletin, avatarCrop: avatarCrop)',
    'let patch = RoomPatch(name: name, bulletin: bulletin, avatarCrop: avatarCrop, cwd: cwd, extraCwds: extraCwds)'
)

with open('ios/App/Session.swift', 'w') as f:
    f.write(content)

with open('ios/App/GroupProfileView.swift', 'r') as f:
    content = f.read()

content = content.replace(
    '''        await session.updateRoom(
            id: room.id,
            name: name,
            bulletin: bulletin,
            avatarCrop: avatarCrop
        )''',
    '''        await session.updateRoom(
            id: room.id,
            name: name,
            bulletin: bulletin,
            avatarCrop: avatarCrop,
            cwd: currentRoom.cwd,
            extraCwds: currentRoom.extraCwds
        )'''
)

with open('ios/App/GroupProfileView.swift', 'w') as f:
    f.write(content)

