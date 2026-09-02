import re

with open('ios/Sources/CompanionCore/Models.swift', 'r') as f:
    content = f.read()

# Add RoomPatch
if 'public struct RoomPatch: Encodable, Sendable {' not in content:
    room_patch = """
public struct RoomPatch: Encodable, Sendable {
    public var name: String?
    public var bulletin: String?
    public var avatarUrl: BotProfilePatch.AvatarURL?
    public var avatarCrop: AvatarCrop?
    public var cwd: String?
    public var extraCwds: [String]?

    public init(
        name: String? = nil,
        bulletin: String? = nil,
        avatarUrl: BotProfilePatch.AvatarURL? = nil,
        avatarCrop: AvatarCrop? = nil,
        cwd: String? = nil,
        extraCwds: [String]? = nil
    ) {
        self.name = name
        self.bulletin = bulletin
        self.avatarUrl = avatarUrl
        self.avatarCrop = avatarCrop
        self.cwd = cwd
        self.extraCwds = extraCwds
    }

    private enum CodingKeys: String, CodingKey {
        case name, bulletin, avatarUrl, avatarCrop, cwd, extraCwds
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encodeIfPresent(name, forKey: .name)
        try values.encodeIfPresent(bulletin, forKey: .bulletin)
        if let avatarUrl {
            switch avatarUrl {
            case let .set(path): try values.encode(path, forKey: .avatarUrl)
            case .clear: try values.encodeNil(forKey: .avatarUrl)
            }
        }
        try values.encodeIfPresent(avatarCrop, forKey: .avatarCrop)
        try values.encodeIfPresent(cwd, forKey: .cwd)
        try values.encodeIfPresent(extraCwds, forKey: .extraCwds)
    }
}
"""
    # Append to Models.swift
    with open('ios/Sources/CompanionCore/Models.swift', 'a') as f2:
        f2.write(room_patch)

with open('ios/Sources/CompanionCore/Client.swift', 'r') as f:
    content = f.read()

if 'func updateRoom(' not in content:
    update_room = """
    public func updateRoom(id: String, patch: RoomPatch) async throws -> Room {
        struct RoomResponse: Decodable { let group: Room }
        return try await send(
            try makeRequest("PATCH", "/api/groups/\\(id)", encodedBody: patch),
            as: RoomResponse.self
        ).group
    }
"""
    content = content.replace('public func uploadAvatar', update_room.lstrip() + '\n    public func uploadAvatar')
    with open('ios/Sources/CompanionCore/Client.swift', 'w') as f2:
        f2.write(content)

