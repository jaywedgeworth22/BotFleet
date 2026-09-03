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
    @State private var instanceId: String
    @State private var modelId: String
    @State private var fallbacks: [ModelSelection]
    @State private var computers: Set<String>
    @State private var chiefOfStaff: Bool
    @State private var approvePeerComms: Bool
    @State private var autoApprove: Bool
    @State private var autoReview: String
    @State private var composio: Bool
    @State private var cloudBackend: String
    @State private var autoStartVps: Bool
    @State private var cwd: String
    @State private var extraCwdsText: String
    @State private var userNotes: String
    @State private var photo: PhotosPickerItem?
    @State private var prompt = ""
    @State private var voices: [Voice] = []
    @State private var instances: [Instance] = []
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
        _instanceId = State(initialValue: bot.modelSelection.instanceId)
        _modelId = State(initialValue: bot.modelSelection.model)
        _fallbacks = State(initialValue: bot.modelSelection.fallbacks ?? [])
        _computers = State(initialValue: Set(bot.computers ?? []))
        _chiefOfStaff = State(initialValue: bot.chiefOfStaff == true)
        _approvePeerComms = State(initialValue: bot.approvePeerComms == true)
        _autoApprove = State(initialValue: bot.autoApprove == true)
        _autoReview = State(initialValue: bot.autoReview ?? "off")
        _composio = State(initialValue: bot.composio ?? true)
        _cloudBackend = State(initialValue: bot.cloudBackend ?? "box")
        _autoStartVps = State(initialValue: bot.autoStartVps == true)
        _cwd = State(initialValue: bot.cwd ?? "")
        _extraCwdsText = State(initialValue: bot.extraCwds?.joined(separator: "\n") ?? "")
        _userNotes = State(initialValue: bot.userNotes ?? "")
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

                Section("Model & Fallbacks") {
                    if instances.isEmpty {
                        Text("Loading models...")
                            .foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Primary Model")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            
                            Picker("Provider", selection: $instanceId) {
                                ForEach(instances) { instance in
                                    Text(instance.displayName ?? instance.instanceId).tag(instance.id)
                                }
                            }
                            .onChange(of: instanceId) { _, newInstanceId in
                                if let instance = instances.first(where: { $0.id == newInstanceId }) {
                                    if !instance.models.options.contains(where: { $0.id == modelId }) {
                                        modelId = instance.models.default
                                    }
                                }
                            }

                            if let selectedInstance = instances.first(where: { $0.id == instanceId }) {
                                Picker("Model", selection: $modelId) {
                                    ForEach(selectedInstance.models.options) { option in
                                        Text(option.label).tag(option.id)
                                    }
                                }
                            }
                        }
                        
                        ForEach(fallbacks.indices, id: \.self) { index in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text("Fallback \(index + 1)")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Button(role: .destructive) {
                                        fallbacks.remove(at: index)
                                    } label: {
                                        Image(systemName: "trash")
                                            .font(.caption)
                                            .foregroundStyle(.red)
                                    }
                                    .buttonStyle(.borderless)
                                }
                                .padding(.top, 4)

                                Picker("Provider", selection: Binding(
                                    get: { fallbacks[index].instanceId },
                                    set: { newInstanceId in
                                        fallbacks[index].instanceId = newInstanceId
                                        if let inst = instances.first(where: { $0.id == newInstanceId }) {
                                            if !inst.models.options.contains(where: { $0.id == fallbacks[index].model }) {
                                                fallbacks[index].model = inst.models.default
                                            }
                                        }
                                    }
                                )) {
                                    ForEach(instances) { instance in
                                        Text(instance.displayName ?? instance.instanceId).tag(instance.id)
                                    }
                                }

                                if let fallbackInstance = instances.first(where: { $0.id == fallbacks[index].instanceId }) {
                                    Picker("Model", selection: Binding(
                                        get: { fallbacks[index].model },
                                        set: { newModel in
                                            fallbacks[index].model = newModel
                                        }
                                    )) {
                                        ForEach(fallbackInstance.models.options) { option in
                                            Text(option.label).tag(option.id)
                                        }
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        
                        if fallbacks.count < 2 {
                            Button {
                                let firstInst = instances.first
                                let instId = firstInst?.id ?? instanceId
                                let mdl = firstInst?.models.default ?? modelId
                                fallbacks.append(ModelSelection(instanceId: instId, model: mdl))
                            } label: {
                                Label("Add fallback model", systemImage: "plus.circle")
                            }
                        }
                    }
                }

                Section("Coordination") {
                    Toggle("Chief of Staff", isOn: $chiefOfStaff)
                    Toggle("Ask before contacting peers", isOn: $approvePeerComms)
                    Toggle("Connected apps (Composio)", isOn: $composio)
                }

                Section("Autonomous Execution") {
                    Toggle("Auto mode", isOn: $autoApprove)
                    Picker("Routine reviews", selection: $autoReview) {
                        Text("Off").tag("off")
                        Text("Shadow").tag("shadow")
                        Text("Enforce").tag("enforce")
                    }
                }

                Section("Computers & Environment") {
                    ForEach(["local", "cloud", "vm"], id: \.self) { comp in
                        let label = comp == "local" ? "This computer" : comp == "vm" ? "VPS" : "Cloud VM"
                        Toggle(label, isOn: Binding(
                            get: { computers.contains(comp) },
                            set: { isOn in
                                if isOn {
                                    computers.insert(comp)
                                } else {
                                    computers.remove(comp)
                                }
                            }
                        ))
                    }

                    Picker("Cloud backend", selection: $cloudBackend) {
                        Text("Box VM").tag("box")
                        Text("VPS").tag("vps")
                    }

                    Toggle("Start VPS automatically", isOn: $autoStartVps)

                    TextField("Working directory (cwd)", text: $cwd)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    TextField("Additional repos (one per line)", text: $extraCwdsText, axis: .vertical)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .lineLimit(2...5)
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

                Section("Memory & Notes") {
                    TextField("Custom instructions & persistent notes", text: $userNotes, axis: .vertical)
                        .lineLimit(4...10)
                }

                if let tasks = current.tasks, !tasks.isEmpty {
                    let totalTurns = tasks.compactMap { $0.usage?.turns }.reduce(0, +)
                    let totalInput = tasks.compactMap { $0.usage?.input }.reduce(0, +)
                    let totalOutput = tasks.compactMap { $0.usage?.output }.reduce(0, +)
                    let totalCost = tasks.compactMap { $0.usage?.costUsd }.reduce(0, +)
                    let hasCost = tasks.contains(where: { $0.usage?.costUsd != nil })
                    
                    if totalTurns > 0 {
                        Section("Usage") {
                            HStack {
                                Text("Turns")
                                Spacer()
                                Text("\(totalTurns)")
                                    .foregroundStyle(.secondary)
                            }
                            HStack {
                                Text("Tokens")
                                Spacer()
                                Text("\((totalInput + totalOutput) / 1000)k (\(totalInput / 1000)k in, \(totalOutput / 1000)k out)")
                                    .foregroundStyle(.secondary)
                            }
                            if hasCost {
                                HStack {
                                    Text("Cost")
                                    Spacer()
                                    Text(String(format: "$%.2f", totalCost))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Agent Settings")
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
            .task {
                async let status = session.configStatus()
                async let options = session.voiceOptions()
                async let fetchedInstances = session.instances()
                let loadedConfig = await status
                config = loadedConfig
                let rawInstances = await fetchedInstances
                instances = rawInstances.filter { inst in
                    inst.snapshot.isAvailable || inst.id == current.modelSelection.instanceId
                }
                if let loadedConfig, !loadedConfig.canSpeak(agentVoice: voice) {
                    speakReplies = false
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
        let newModelSelection = ModelSelection(instanceId: instanceId, model: modelId, fallbacks: fallbacks.isEmpty ? nil : fallbacks)
        let newComputers = Array(computers).sorted()
        let baselineComputers = (baseline.computers ?? []).sorted()
        let splitExtraCwds = extraCwdsText.isEmpty ? nil : extraCwdsText.components(separatedBy: .newlines).filter({ !$0.trimmingCharacters(in: .whitespaces).isEmpty })
        return BotProfilePatch(
            name: name == baseline.name ? nil : name.trimmingCharacters(in: .whitespacesAndNewlines),
            title: title == baseline.title ? nil : title.trimmingCharacters(in: .whitespacesAndNewlines),
            description: description == baseline.description
                ? nil : description.trimmingCharacters(in: .whitespacesAndNewlines),
            notifications: notifications == baseline.notifications ? nil : notifications,
            avatarCrop: crop == baseline.crop ? nil : crop,
            voice: voice == baseline.voice ? nil : voice,
            speakReplies: savedSpeakReplies == baseline.speakReplies ? nil : savedSpeakReplies,
            modelSelection: newModelSelection == baseline.modelSelection ? nil : newModelSelection,
            computers: newComputers == baselineComputers ? nil : newComputers,
            chiefOfStaff: chiefOfStaff == baseline.chiefOfStaff ? nil : chiefOfStaff,
            approvePeerComms: approvePeerComms == baseline.approvePeerComms ? nil : approvePeerComms,
            autoApprove: autoApprove == baseline.autoApprove ? nil : autoApprove,
            autoReview: autoReview == baseline.autoReview ? nil : autoReview,
            composio: composio == baseline.composio ? nil : composio,
            cloudBackend: cloudBackend == baseline.cloudBackend ? nil : cloudBackend,
            autoStartVps: autoStartVps == baseline.autoStartVps ? nil : autoStartVps,
            cwd: cwd == baseline.cwd ? nil : cwd.trimmingCharacters(in: .whitespacesAndNewlines),
            extraCwds: splitExtraCwds == baseline.extraCwds ? nil : splitExtraCwds,
            userNotes: userNotes == baseline.userNotes ? nil : userNotes
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
        let shapePatch = BotProfilePatch(avatarCrop: intendedCrop)
        if let updated = await session.updateProfile(shapePatch, for: generated) {
            crop = updated.avatarCrop ?? intendedCrop
            baseline.crop = crop
        } else {
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
        instanceId = bot.modelSelection.instanceId
        modelId = bot.modelSelection.model
        fallbacks = bot.modelSelection.fallbacks ?? []
        computers = Set(bot.computers ?? [])
        chiefOfStaff = bot.chiefOfStaff == true
        approvePeerComms = bot.approvePeerComms == true
        autoApprove = bot.autoApprove == true
        autoReview = bot.autoReview ?? "off"
        composio = bot.composio ?? true
        cloudBackend = bot.cloudBackend ?? "box"
        autoStartVps = bot.autoStartVps == true
        cwd = bot.cwd ?? ""
        extraCwdsText = bot.extraCwds?.joined(separator: "\n") ?? ""
        userNotes = bot.userNotes ?? ""
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
    var computers: [String]?
    var chiefOfStaff: Bool
    var approvePeerComms: Bool
    var autoApprove: Bool
    var autoReview: String
    var composio: Bool
    var cloudBackend: String
    var autoStartVps: Bool
    var cwd: String
    var extraCwds: [String]?
    var userNotes: String

    init(bot: Bot) {
        name = bot.name
        title = bot.title
        description = bot.description
        notifications = bot.notifications
        crop = bot.avatarCrop ?? .mascot
        voice = bot.voice ?? ""
        speakReplies = bot.speakReplies == true
        modelSelection = bot.modelSelection
        computers = bot.computers
        chiefOfStaff = bot.chiefOfStaff == true
        approvePeerComms = bot.approvePeerComms == true
        autoApprove = bot.autoApprove == true
        autoReview = bot.autoReview ?? "off"
        composio = bot.composio ?? true
        cloudBackend = bot.cloudBackend ?? "box"
        autoStartVps = bot.autoStartVps == true
        cwd = bot.cwd ?? ""
        extraCwds = bot.extraCwds
        userNotes = bot.userNotes ?? ""
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

