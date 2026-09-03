import SwiftUI
import PhotosUI
import CompanionCore

struct GroupProfileView: View {
    let room: Room
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: Session

    @State private var name = ""
    @State private var bulletin = ""
    @State private var avatarCrop: AvatarCrop = .circle
    @State private var cwd = ""
    @State private var extraCwdsText = ""
    @State private var responderKind = "everyone"
    @State private var leadBotId = ""
    @State private var memberIds: Set<String> = []
    @State private var photo: PhotosPickerItem? = nil
    @State private var busy = false

    private var roomTerm: String {
        session.config?.roomTerminologyLabel ?? "Channel"
    }

    private var availableBots: [Bot] {
        session.state.bots
    }

    private var currentRoom: CompanionCore.Room {
        var r = room
        r.name = name
        r.bulletin = bulletin
        r.avatarUrl = session.state.rooms.first(where: { $0.id == room.id })?.avatarUrl ?? room.avatarUrl
        r.avatarCrop = avatarCrop
        r.cwd = cwd.isEmpty ? nil : cwd
        r.extraCwds = extraCwdsText.isEmpty ? nil : extraCwdsText.components(separatedBy: .newlines).filter({ !$0.trimmingCharacters(in: .whitespaces).isEmpty })
        // Server vocabulary (server/index.ts checkedGroupResponder): everyone | mentions | member+botId.
        r.defaultResponder = GroupResponder(kind: responderKind, botId: responderKind == "member" ? (leadBotId.isEmpty ? nil : leadBotId) : nil)
        r.memberIds = Array(memberIds)
        return r
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        PhotosPicker(selection: $photo, matching: .images, photoLibrary: .shared()) {
                            ChatAvatarView(chat: .room(currentRoom), size: 120)
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

                    if (session.state.rooms.first(where: { $0.id == room.id })?.avatarUrl ?? room.avatarUrl) != nil {
                        Picker("Photo shape", selection: $avatarCrop) {
                            Text("Circle").tag(AvatarCrop.circle)
                            Text("Rounded").tag(AvatarCrop.rounded)
                            Text("Square").tag(AvatarCrop.square)
                        }
                        .pickerStyle(.segmented)
                        .disabled(busy)

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

                Section("\(roomTerm) Details") {
                    TextField("Name", text: $name)
                        .disabled(busy)
                        .autocorrectionDisabled()
                    TextField("Bulletin (Instructions for the team)", text: $bulletin, axis: .vertical)
                        .disabled(busy)
                        .lineLimit(2...6)
                }

                if room.dm != true {
                Section("Default Responder") {
                    Picker("Responder Mode", selection: $responderKind) {
                        Text("Everyone responds").tag("everyone")
                        Text("Lead bot").tag("member")
                        Text("Only when mentioned").tag("mentions")
                    }

                    if responderKind == "member" {
                        Picker("Lead Bot", selection: $leadBotId) {
                            Text("Select lead bot").tag("")
                            ForEach(availableBots.filter { memberIds.contains($0.id) }) { bot in
                                Text(bot.name).tag(bot.id)
                            }
                        }
                    }
                }

                Section("Members") {
                    ForEach(availableBots) { bot in
                        Toggle(isOn: Binding(
                            get: { memberIds.contains(bot.id) },
                            set: { isMember in
                                if isMember {
                                    memberIds.insert(bot.id)
                                    if leadBotId.isEmpty { leadBotId = bot.id }
                                } else {
                                    memberIds.remove(bot.id)
                                    if leadBotId == bot.id {
                                        leadBotId = memberIds.first ?? ""
                                    }
                                }
                            }
                        )) {
                            HStack(spacing: 10) {
                                BotAvatarView(bot: bot, size: 28)
                                VStack(alignment: .leading) {
                                    Text(bot.name)
                                        .font(.body)
                                    if !bot.title.isEmpty {
                                        Text(bot.title)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
                }

                Section("Working Directory") {
                    TextField("Folder path on host (optional)", text: $cwd)
                        .disabled(busy)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                
                Section("Additional Repositories") {
                    TextField("One path per line", text: $extraCwdsText, axis: .vertical)
                        .disabled(busy)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .lineLimit(3...8)
                }
            }
            .navigationTitle("\(roomTerm) Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Save") {
                        Task {
                            await save()
                            dismiss()
                        }
                    }
                    .fontWeight(.semibold)
                    .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Discard") {
                        dismiss()
                    }
                }
            }
            .overlay { if busy { ProgressView().controlSize(.large) } }
            .onAppear {
                name = room.name
                bulletin = room.bulletin
                avatarCrop = room.avatarCrop ?? .circle
                cwd = room.cwd ?? ""
                extraCwdsText = room.extraCwds?.joined(separator: "\n") ?? ""
                responderKind = room.defaultResponder.kind
                leadBotId = room.defaultResponder.botId ?? ""
                memberIds = Set(room.memberIds)
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
        await session.updateRoom(
            id: room.id,
            name: name,
            bulletin: bulletin,
            avatarCrop: avatarCrop,
            cwd: currentRoom.cwd,
            extraCwds: currentRoom.extraCwds,
            // Direct-message rooms cannot change members or responder (server 400s).
            defaultResponder: room.dm == true ? nil : currentRoom.defaultResponder,
            memberIds: room.dm == true ? nil : currentRoom.memberIds
        )
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
