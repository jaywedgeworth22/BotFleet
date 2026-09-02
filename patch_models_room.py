import re

with open('ios/Sources/CompanionCore/Models.swift', 'r') as f:
    content = f.read()

room_regex = re.compile(r'(public struct Room: Codable, Hashable, Identifiable, Sendable \{.*?public var dm: Bool\?)', re.DOTALL)
room_replacement = r'\1\n    public var avatarUrl: String?\n    public var avatarCrop: AvatarCrop?\n    public var cwd: String?\n    public var extraCwds: [String]?'
content = room_regex.sub(room_replacement, content)

with open('ios/Sources/CompanionCore/Models.swift', 'w') as f:
    f.write(content)

