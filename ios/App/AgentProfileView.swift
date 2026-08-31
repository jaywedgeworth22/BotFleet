import AVFAudio
import CompanionCore
import PhotosUI
import SwiftUI

/// The paired-safe subset of an agent profile. Shared provider keys remain on
/// the computer; the phone sees only configured/not-configured status and the
/// renderer-neutral voice/avatar operations.
struct AgentProfileView: View {
    let bot: Bot

    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var title: String
    @State private var description: String
    @State private var notifications: Bool
    @State private var crop: AvatarCrop
    @State private var voice: String
    @State private var speakReplies: Bool
    @State private var modelSelection: ModelSelection
    @State private var photo: PhotosPickerItem?
    @State private var prompt = ""
    @State private var voices: [Voice] = []
    @State private var instances: [CompanionCore.Instance] = []
    @State private var config: ConfigStatus?
    @State private var busy = false
    @State private var player: AVAudioPlayer?
    @State private var baseline: ProfileFormSnapshot

    init(bot: Bot) {
        self.bot = bot
        _name = State(initialValue: bot.name)
        _title = State(initialValue: bot.title)
        _description = State(initialValue: bot.description)
        _notifications = State(initialValue: bot.notifications)
        _crop = State(initialValue: bot.avatarCrop ?? .mascot)
        _voice = State(initialValue: bot.voice ?? "")
        _speakReplies = State(initialValue: bot.speakReplies == true)
        _modelSelection = State(initialValue: bot.modelSelection)
        _baseline = State(initialValue: ProfileFormSnapshot(bot: bot))
    }

    private var current: Bot { session.state.bot(bot.id) ?? bot }
    private var imageGenerationReady: Bool { config?.imageGen?.configured == true }
    private var voiceConfigured: Bool { config?.isTTSConfigured == true }
    private var hasWorkspaceDefaultVoice: Bool { config?.hasWorkspaceDefaultVoice == true }
    private var selectedVoiceCanSpeak: Bool { config?.canSpeak(agentVoice: voice) == true }
    /// Which engine's words to use. An unloaded status is ElevenLabs for the
    /// same reason a missing `provider` is: that is the server's own fallback,
    /// and the copy that shipped.
    private var usesSystemVoices: Bool { config?.voiceProvider == .system }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        BotAvatarView(bot: current, size: 112, state: .happy, animated: true)
                        Spacer()
                    }
                    .listRowBackground(Color.clear)

                    Picker("Shape", selection: $crop) {
                        ForEach(AvatarCrop.allCases, id: \.self) { shape in
                            Text(shape.label).tag(shape)
                        }
                    }
                    .pickerStyle(.segmented)

                    PhotosPicker(selection: $photo, matching: .images) {
                        Label("Upload image", systemImage: "photo.badge.plus")
                    }
                    .disabled(busy)

                    if current.avatarUrl != nil {
                        Button("Use mascot", systemImage: "trash", role: .destructive) {
                            Task { await clearImage() }
                        }
                        .disabled(busy)
                    }
                } header: {
                    Text("Avatar")
                } footer: {
                    Text("PNG, JPEG, GIF, or WebP, up to 10 MB. Images are stored on your paired computer and loaded with this phone's pairing token.")
                }

                Section {
                    TextField("Art direction", text: $prompt, axis: .vertical)
                        .lineLimit(2...5)
                    Button("Generate on computer", systemImage: "sparkles") {
                        Task { await generateImage() }
                    }
                    .disabled(busy || !imageGenerationReady || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: {
                    Text("Generate an avatar")
                } footer: {
                    Text(imageGenerationReady
                         ? "Generation uses the shared image provider configured on your computer. No provider key is sent to or stored on this phone."
                         : "To generate images, configure the shared image provider in BotFleet on your computer. Provider keys cannot be added from a phone.")
                }

                Section("Identity") {
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                    TextField("Title", text: $title)
                    TextField("What this agent does", text: $description, axis: .vertical)
                        .lineLimit(3...8)
                    Toggle("Agent notifications", isOn: $notifications)
                }


                Section {
                    PrimaryPickerView(modelSelection: $modelSelection, instances: instances)

                    if let fallbacks = modelSelection.fallbacks {
                        ForEach(Array(fallbacks.enumerated()), id: \.offset) { index, fallback in
                            FallbackPickerView(modelSelection: $modelSelection, index: index, instances: instances)
                        }
                        .onDelete { indices in
                            modelSelection.fallbacks?.remove(atOffsets: indices)
                            if modelSelection.fallbacks?.isEmpty == true {
                                modelSelection.fallbacks = nil
                            }
                        }
                    }

                    Button("+ Add Fallback Model") {
                        if modelSelection.fallbacks == nil {
                            modelSelection.fallbacks = []
                        }
                        if let firstInstance = instances.first, let firstModel = firstInstance.models.options.first {
                            modelSelection.fallbacks?.append(ModelSelection(instanceId: firstInstance.id, model: firstModel.id))
                        }
                    }
                } header: {
                    Text("Model")
                }

                Section {
                    if voiceConfigured {
                        Picker("Voice", selection: $voice) {
                            if hasWorkspaceDefaultVoice {
                                Text("Workspace default").tag("")
                            } else {
                                Text("Choose an agent voice").tag("").disabled(true)
                            }
                            if !voice.isEmpty, !voices.contains(where: { $0.id == voice }) {
                                Text("Current agent voice").tag(voice)
                            }
                            ForEach(voices) { option in
                                VStack(alignment: .leading) {
                                    Text(option.label)
                                    if let detail = option.description { Text(detail) }
                                }
                                .tag(option.id)
                            }
                        }
                        Toggle("Speak replies", isOn: $speakReplies)
                            .disabled(!selectedVoiceCanSpeak)
                        Button("Preview voice", systemImage: "speaker.wave.2") {
                            Task { await previewVoice() }
                        }
                        .disabled(busy || !selectedVoiceCanSpeak)

                        if !hasWorkspaceDefaultVoice, voice.isEmpty {
                            Label("Pick a voice for this agent before enabling speech.", systemImage: "info.circle")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } else if usesSystemVoices {
                        Label("Built-in Mac voices are unavailable", systemImage: "speaker.slash")
                            .foregroundStyle(.secondary)
                    } else {
                        Label("ElevenLabs is not configured", systemImage: "speaker.slash")
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Voice")
                } footer: {
                    if !voiceConfigured {
                        // Under the built-in engine "not configured" is not a
                        // missing credential — there is none — so the remedy
                        // cannot be a key. `providerConfigured` in
                        // `server/tts/index.ts` is reporting that this
                        // computer has no built-in voices to speak with.
                        if usesSystemVoices {
                            Text("Built-in Mac voices need no key, and this computer has none available. Switch the voice engine to ElevenLabs in this agent's profile on the computer to keep using voice.")
                        } else {
                            Text("Add the shared ElevenLabs key in this agent's profile on the computer. The key is never returned to iOS.")
                        }
                    } else if !hasWorkspaceDefaultVoice {
                        if usesSystemVoices {
                            Text("No workspace default voice is selected. Choose an agent-specific voice above; synthesis still uses the built-in Mac voices on your computer.")
                        } else {
                            Text("No workspace default voice is selected. Choose an agent-specific voice above; synthesis still uses the shared ElevenLabs key on your computer.")
                        }
                    } else {
                        Text("The voice choice belongs to this agent. Workspace default uses the shared voice selected on your computer.")
                    }
                }

                Section {
                    Button("Save profile") { Task { await save() } }
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("Agent profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
            .overlay { if busy { ProgressView().controlSize(.large) } }
            .task {
                async let status = session.configStatus()
                async let options = session.voiceOptions()
                let loadedConfig = await status
                config = loadedConfig
                voices = await options
                if let loadedConfig, !loadedConfig.canSpeak(agentVoice: voice) {
                    speakReplies = false
                }
                do {
                    if let loadedInstances = try await session.clientInstances() {
                        self.instances = loadedInstances
                    }
                } catch {
                    print("Failed to load instances: \(error)")
                }
            }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                Task { await upload(item) }
            }
        }
    }

    private func profilePatch() -> BotProfilePatch {
        let savedSpeakReplies = config.map { $0.canSpeak(agentVoice: voice) && speakReplies } ?? speakReplies
        return BotProfilePatch(
            // The shared server contract owns the 100/200/4000 limits. Do not
            // silently apply narrower iOS-only limits to a user's profile.
            name: name == baseline.name ? nil : name.trimmingCharacters(in: .whitespacesAndNewlines),
            title: title == baseline.title ? nil : title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description == baseline.description
                ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines),
            notifications: notifications == baseline.notifications ? nil : notifications,
            avatarCrop: crop == baseline.crop ? nil : crop,
            // Empty is the server's explicit "use workspace default" value;
            // nil would mean the voice field is not part of this patch.
            voice: voice == baseline.voice ? nil : voice,
            speakReplies: savedSpeakReplies == baseline.speakReplies ? nil : savedSpeakReplies,
            modelSelection: modelSelection == baseline.modelSelection ? nil : modelSelection
        )
    }

    private func save() async {
        busy = true
        if let updated = await session.updateProfile(profilePatch(), for: current) {
            synchronizeForm(with: updated)
        }
        busy = false
    }

    private func clearImage() async {
        busy = true
        defer { busy = false }
        if let updated = await session.updateProfile(
            BotProfilePatch(avatarUrl: .clear, avatarCrop: .mascot),
            for: current
        ) {
            crop = updated.avatarCrop ?? .mascot
            baseline.crop = crop
        }
    }

    private func upload(_ item: PhotosPickerItem) async {
        busy = true
        defer { busy = false; photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let mime = Self.imageMIME(data)
        else {
            session.actionError = "Choose a PNG, JPEG, GIF, or WebP image."
            return
        }
        if data.count > 10 * 1_024 * 1_024 {
            session.actionError = "That image is larger than 10 MB."
            return
        }
        let intendedCrop = crop == .mascot ? AvatarCrop.circle : crop
        if let updated = await session.uploadAvatar(data, mime: mime, for: current, crop: intendedCrop) {
            crop = updated.avatarCrop ?? intendedCrop
            baseline.crop = crop
        }
    }

    private func generateImage() async {
        busy = true
        defer { busy = false }
        let intendedCrop = crop == .mascot ? AvatarCrop.circle : crop
        guard let generated = await session.generateAvatar(
            prompt: String(prompt.trimmingCharacters(in: .whitespacesAndNewlines).prefix(400)),
            for: current
        ) else { return }
        // Generation chooses a safe default crop server-side. The selector is
        // the user's explicit choice, so persist it immediately against the
        // returned attachment rather than leaving UI and server out of sync.
        let shapePatch = BotProfilePatch(avatarCrop: intendedCrop)
        if let updated = await session.updateProfile(shapePatch, for: generated) {
            crop = updated.avatarCrop ?? intendedCrop
            baseline.crop = crop
        } else {
            // Generation itself succeeded. Reflect its authoritative fallback
            // rather than claiming the requested crop was persisted.
            crop = generated.avatarCrop ?? .mascot
            baseline.crop = crop
        }
    }

    private func previewVoice() async {
        guard selectedVoiceCanSpeak else {
            session.actionError = "Pick an agent voice or configure a workspace default on your computer first."
            return
        }
        busy = true
        defer { busy = false }
        guard let data = await session.previewVoice(voice, for: current) else { return }
        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.playback, mode: .spokenAudio)
            try audioSession.setActive(true)

            let nextPlayer = try AVAudioPlayer(data: data)
            guard nextPlayer.prepareToPlay(), nextPlayer.play() else {
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                player = nil
                session.actionError = "The generated audio could not be played."
                return
            }
            player = nextPlayer
        } catch {
            player = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            session.actionError = "The generated audio could not be played."
        }
    }

    private static func imageMIME(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) { return "image/png" }
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { return "image/jpeg" }
        if bytes.starts(with: Array("GIF8".utf8)) { return "image/gif" }
        if bytes.count >= 12,
           String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF",
           String(bytes: bytes[8..<12], encoding: .ascii) == "WEBP" { return "image/webp" }
        return nil
    }

    private func synchronizeForm(with bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        crop = bot.avatarCrop ?? .mascot
        voice = bot.voice ?? ""
        speakReplies = bot.speakReplies == true
        modelSelection = bot.modelSelection
        baseline = ProfileFormSnapshot(bot: bot)
    }
}

private struct ProfileFormSnapshot {
    var name: String
    var title: String
    var description: String
    var notifications: Bool
    var crop: AvatarCrop
    var voice: String
    var speakReplies: Bool
    var modelSelection: ModelSelection

    init(bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        crop = bot.avatarCrop ?? .mascot
        voice = bot.voice ?? ""
        speakReplies = bot.speakReplies == true
        modelSelection = bot.modelSelection
    }
}

private extension AvatarCrop {
    var label: String {
        switch self {
        case .mascot: "Mascot"
        case .circle: "Circle"
        case .rounded: "Rounded"
        case .square: "Square"
        }
    }
}

struct FallbackPickerView: View {
    @Binding var modelSelection: ModelSelection
    let index: Int
    let instances: [CompanionCore.Instance]

    var body: some View {
        Picker("Fallback \(index + 1)", selection: Binding(
            get: { modelSelection.fallbacks?[index].model ?? "" },
            set: { newModel in
                if let instance = instances.first(where: { $0.models.options.contains(where: { $0.id == newModel }) }) {
                    modelSelection.fallbacks?[index].instanceId = instance.id
                    modelSelection.fallbacks?[index].model = newModel
                }
            }
        )) {
            ForEach(instances) { instance in
                Section(instance.displayName ?? instance.id) {
                    ForEach(instance.models.options) { option in
                        Text(option.label).tag(option.id)
                    }
                }
            }
        }
    }
}

struct PrimaryPickerView: View {
    @Binding var modelSelection: ModelSelection
    let instances: [CompanionCore.Instance]

    var body: some View {
        Picker("Primary model", selection: Binding(
            get: { modelSelection.model },
            set: { newModel in
                if let instance = instances.first(where: { $0.models.options.contains(where: { $0.id == newModel }) }) {
                    modelSelection.instanceId = instance.id
                    modelSelection.model = newModel
                }
            }
        )) {
            ForEach(instances) { instance in
                Section(instance.displayName ?? instance.id) {
                    ForEach(instance.models.options) { option in
                        Text(option.label).tag(option.id)
                    }
                }
            }
        }
    }
}

struct GroupProfileView: View {
    let room: Room
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session: Session

    @State private var name = ""
    @State private var bulletin = ""
    @State private var avatarCrop: AvatarCrop = .circle
    @State private var cwd = ""
    @State private var photo: PhotosPickerItem? = nil
    @State private var busy = false

    var currentRoom: CompanionCore.Room {
        var r = room
        r.name = name
        r.bulletin = bulletin
        r.avatarUrl = session.state.rooms.first(where: { $0.id == room.id })?.avatarUrl ?? room.avatarUrl
        r.avatarCrop = avatarCrop
        r.cwd = cwd.isEmpty ? nil : cwd
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

                Section("Channel Details") {
                    TextField("Name", text: $name)
                        .disabled(busy)
                        .autocorrectionDisabled()
                    TextField("Bulletin (Instructions for the team)", text: $bulletin, axis: .vertical)
                        .disabled(busy)
                        .lineLimit(2...6)
                }

                Section("Working Directory") {
                    TextField("Folder path on host (optional)", text: $cwd)
                        .disabled(busy)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
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
                avatarCrop = room.avatarCrop ?? .circle
                cwd = room.cwd ?? ""
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
            avatarCrop: avatarCrop
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
