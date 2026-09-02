import re

with open('ios/App/Session.swift', 'r') as f:
    content = f.read()

if 'func updateRoom(' not in content:
    update_room = """
    @MainActor
    func updateRoom(id: String, name: String?, bulletin: String?, avatarCrop: AvatarCrop?) async {
        guard let client = activeClient else { return }
        do {
            let patch = RoomPatch(name: name, bulletin: bulletin, avatarCrop: avatarCrop)
            let updated = try await client.updateRoom(id: id, patch: patch)
            if let index = state.rooms.firstIndex(where: { $0.id == updated.id }) {
                state.rooms[index] = updated
            }
        } catch {
            actionError = error.localizedDescription
        }
    }

    @MainActor
    func updateRoomAvatar(id: String, avatarUrl: String?) async {
        guard let client = activeClient else { return }
        do {
            let urlVal: BotProfilePatch.AvatarURL?
            if let url = avatarUrl {
                urlVal = .set(url)
            } else {
                urlVal = .clear
            }
            let patch = RoomPatch(avatarUrl: urlVal, avatarCrop: .circle)
            let updated = try await client.updateRoom(id: id, patch: patch)
            if let index = state.rooms.firstIndex(where: { $0.id == updated.id }) {
                state.rooms[index] = updated
            }
        } catch {
            actionError = error.localizedDescription
        }
    }

    @MainActor
    func uploadRoomAvatar(id: String, data: Data, mime: String) async {
        guard let client = activeClient else { return }
        do {
            let url = try await client.uploadAvatar(data: data, mime: mime)
            await updateRoomAvatar(id: id, avatarUrl: url)
        } catch {
            actionError = error.localizedDescription
        }
    }
"""
    content = content.replace('func updateProfile', update_room.lstrip() + '\n    @MainActor\n    func updateProfile')
    with open('ios/App/Session.swift', 'w') as f2:
        f2.write(content)

