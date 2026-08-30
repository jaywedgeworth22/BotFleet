import SwiftUI
import PhotosUI
import CompanionCore

struct GroupProfileView: View {
    let room: Room
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: Session

    @State private var name = ""
    @State private var bulletin = ""
    @State private var photo: PhotosPickerItem? = nil
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        PhotosPicker(selection: $photo, matching: .images, photoLibrary: .shared()) {
                            RoomAvatarView(room: Room(id: room.id, threadId: room.threadId, name: name, avatarUrl: session.state.group(room.id)?.avatarUrl ?? room.avatarUrl, memberIds: room.memberIds, defaultResponder: room.defaultResponder, bulletin: room.bulletin, unread: room.unread, createdAt: room.createdAt), size: 120, state: .idle, animated: false)
                                .overlay(alignment: .bottomTrailing) {
                                    Image(systemName: "camera.circle.fill")
                                        .symbolRenderingMode(.multicolor)
                                        .font(.system(size: 32))
                                        .background(Circle().fill(Color(uiColor: .systemBackground)))
                                        .padding(-4)
                                }
                        }
                        .disabled(busy)
                        .buttonStyle(.plain)
                        Spacer()
                    }
                    .padding(.vertical, 8)

                    if (session.state.group(room.id)?.avatarUrl ?? room.avatarUrl) != nil {
                        Button(role: .destructive) { Task { await clearImage() } } label: {
                            HStack {
                                Spacer()
                                Text("Remove photo")
                                Spacer()
                            }
                        }
                        .disabled(busy)
                    }
                }

                Section {
                    TextField("Name", text: $name)
                        .disabled(busy)
                        .autocorrectionDisabled()
                    TextField("Bulletin (Instructions for the team)", text: $bulletin, axis: .vertical)
                        .disabled(busy)
                        .lineLimit(2...6)
                }

                Section {
                    Button("Save profile") { Task { await save() } }
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("Group profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .overlay { if busy { ProgressView().controlSize(.large) } }
            .onAppear {
                name = room.name
                bulletin = room.bulletin
            }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                Task { await upload(item) }
            }
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        await session.updateRoom(id: room.id, name: name, bulletin: bulletin)
    }

    private func clearImage() async {
        busy = true
        defer { busy = false }
        await session.updateRoomAvatar(id: room.id, avatarUrl: nil)
    }

    private func upload(_ item: PhotosPickerItem) async {
        busy = true
        defer { busy = false; photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let mime = imageMIME(data)
        else {
            session.actionError = "Choose a PNG, JPEG, GIF, or WebP image."
            return
        }
        if data.count > 10 * 1_024 * 1_024 {
            session.actionError = "That image is larger than 10 MB."
            return
        }
        await session.uploadRoomAvatar(id: room.id, data: data, mime: mime)
    }

    private func imageMIME(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) { return "image/png" }
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { return "image/jpeg" }
        if bytes.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if bytes.count >= 12,
           String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
           String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP" { return "image/webp" }
        return nil
    }
}
