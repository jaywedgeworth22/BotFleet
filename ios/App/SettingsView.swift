// Settings stays status-first. Network details and destructive pairing
// controls live one level deeper so the everyday screen remains calm.
import SwiftUI
import CompanionCore
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @State private var enablingNotifications = false
    @State private var confirmSimpleMerge = false
    @State private var refreshingPushHealth = false
    @State private var engines: [Instance] = []
    @State private var loadingEngines = false
    @State private var engineSheet: Instance?
    @State private var profileName = ""
    @State private var profileEmail = ""
    @State private var roomTimeoutText = "5"
    @State private var roomTimeoutError = ""
    @State private var savingRoomTimeout = false
    private let onConnect: (() -> Void)?

    init(onConnect: (() -> Void)? = nil) {
        self.onConnect = onConnect
    }

    var body: some View {
        Form {
            Section("Computer") {
                if let connection = session.connection {
                    NavigationLink {
                        ConnectionSecurityView()
                    } label: {
                        ComputerSettingsRow(
                            name: connection.name,
                            status: statusText,
                            connected: session.status == .live
                        )
                    }
                } else {
                    Button {
                        onConnect?()
                    } label: {
                        ComputerSettingsRow(
                            name: "Connect a computer",
                            status: "Not connected",
                            connected: false
                        )
                    }
                    .disabled(onConnect == nil)
                }
            }

            if session.connection != nil {
                MacUpdateSection()
            }

            Section {
                if notificationsAreEnabled {
                    notificationRow
                        .accessibilityHint(notificationAccessibilityHint)
                } else {
                    Button {
                        enablingNotifications = true
                        Task {
                            await session.enableNotifications()
                            enablingNotifications = false
                        }
                    } label: {
                        notificationRow
                    }
                    .disabled(enablingNotifications)
                    .accessibilityHint(notificationAccessibilityHint)
                }
            } footer: {
                Text("Alerts arrive while BotFleet is open or was recently in the background. Closed-app delivery is not available yet.")
            }

            if session.connection != nil {
                Section {
                    pushHealthRow
                } header: {
                    Text("Closed-app notifications")
                } footer: {
                    Text(pushHealthFooter)
                }
            }

            if session.connection != nil {
                Section {
                    NavigationLink {
                        TasksRoutinesView()
                    } label: {
                        Label {
                            Text("Tasks & Routines")
                        } icon: {
                            SettingsIcon(symbol: "calendar.badge.clock", color: .orange)
                        }
                    }

                    NavigationLink {
                        ConnectedAppsView()
                    } label: {
                        Label {
                            Text("Connected Apps")
                        } icon: {
                            SettingsIcon(symbol: "link", color: .blue)
                        }
                    }

                    Picker(selection: Binding(
                        get: { session.config?.isProjectsMode == true ? "projects" : "simple" },
                        set: { mode in
                            if mode == "simple", session.config?.isProjectsMode == true {
                                confirmSimpleMerge = true
                            } else {
                                Task { _ = await session.updateConversationMode(mode) }
                            }
                        }
                    )) {
                        Text("Simple").tag("simple")
                        Text("Projects").tag("projects")
                    } label: {
                        Label {
                            Text("Workspace Layout")
                        } icon: {
                            SettingsIcon(symbol: "square.grid.2x2", color: .teal)
                        }
                    }

                    Picker(selection: Binding(
                        get: { session.config?.terminology ?? "channels" },
                        set: { newTerm in
                            Task {
                                if newTerm == "custom" {
                                    // Keep whatever is already stored so
                                    // switching back does not blank the word.
                                    _ = await session.updateTerminology(
                                        "custom",
                                        custom: session.config?.roomLabels
                                    )
                                } else {
                                    _ = await session.updateTerminology(newTerm)
                                }
                            }
                        }
                    )) {
                        Text("Channels").tag("channels")
                        Text("Groups").tag("groups")
                        Text("Projects").tag("projects")
                        Text("Apps").tag("apps")
                        Text("Topics").tag("topics")
                        Text("Repos").tag("repos")
                        Text("Custom").tag("custom")
                    } label: {
                        Label {
                            Text("Room Terminology")
                        } icon: {
                            SettingsIcon(symbol: "text.bubble", color: .indigo)
                        }
                    }
                    if session.config?.terminology == "custom" {
                        CustomRoomTermFields(session: session)
                    }

                    Toggle(isOn: showToolCallsBinding) {
                        Label {
                            Text("Show Tool Calls")
                        } icon: {
                            SettingsIcon(symbol: "wrench.and.screwdriver", color: .purple)
                        }
                    }

                    Toggle(isOn: summarizeToolCallsBinding) {
                        Label {
                            Text("Summarize Bot Tasks")
                        } icon: {
                            SettingsIcon(symbol: "rectangle.stack", color: .mint)
                        }
                    }
                } header: {
                    Text("Workspace")
                } footer: {
                    Text(workspaceFooter)
                }

                Section {
                    HStack {
                        Label {
                            Text("Channel Turn Timeout")
                        } icon: {
                            SettingsIcon(symbol: "timer", color: .orange)
                        }
                        Spacer()
                        TextField("5", text: $roomTimeoutText)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 72)
                            .disabled(savingRoomTimeout)
                            .onSubmit { Task { await saveRoomTimeout() } }
                        Text("min")
                            .foregroundStyle(.secondary)
                        Button("Save") {
                            Task { await saveRoomTimeout() }
                        }
                        .disabled(savingRoomTimeout)
                    }
                    if !roomTimeoutError.isEmpty {
                        Text(roomTimeoutError)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                } header: {
                    Text("Channels")
                } footer: {
                    Text("How long a channel turn can run before it stops.")
                }

                Section {
                    TextField("Name", text: $profileName)
                        .textContentType(.name)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await saveProfile() } }
                    TextField("Email", text: $profileEmail)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await saveProfile() } }
                } header: {
                    Text("You")
                } footer: {
                    Text("Shown in the sidebar.  Saved when you leave a field.")
                }

                Section {
                    if loadingEngines && engines.isEmpty {
                        HStack {
                            ProgressView()
                                .controlSize(.small)
                            Text("Loading engines…")
                                .foregroundStyle(.secondary)
                        }
                    } else if engines.isEmpty {
                        Text("No engines yet.  Finish setup in the Mac app.")
                            .foregroundStyle(.secondary)
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(engines) { engine in
                                    Button {
                                        engineSheet = engine
                                    } label: {
                                        EngineChip(instance: engine)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                } header: {
                    Text("Engines")
                } footer: {
                    Text("Tap an engine to see how to finish setup.  Keys and CLI paths stay on the Mac.")
                }
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await session.refreshNotificationAuthorization()
            // Refresh push-health once on appear.  The row stays useful on
            // subsequent re-entries because `Session.pushSenderHealth` is
            // cached; we deliberately do not poll it (it would re-fire on
            // every background/foreground and the sidecar updates only on
            // an actual send anyway).
            if session.connection != nil {
                await session.refreshPushSenderHealth()
                await loadSettingsExtras()
            }
        }
        .onChange(of: session.connection?.id) { _, _ in
            Task { await loadSettingsExtras() }
        }
        .onChange(of: session.config?.profile?.name) { _, name in
            if profileName != (name ?? "") { profileName = name ?? "" }
        }
        .onChange(of: session.config?.profile?.email) { _, email in
            if profileEmail != (email ?? "") { profileEmail = email ?? "" }
        }
        .onChange(of: session.config?.rooms?.turnTimeoutMinutes) { _, minutes in
            if !savingRoomTimeout, let minutes {
                roomTimeoutText = String(minutes)
            }
        }
        .sheet(item: $engineSheet) { engine in
            EngineSetupSheet(instance: engine)
        }
        .onDisappear {
            Task {
                await saveProfile()
                await saveRoomTimeout()
            }
        }
        .refreshable {
            // Pull-to-refresh on the whole form: the row itself is the
            // obvious target, but a system refresh on the parent makes
            // the gesture discoverable without crowding the row.
            await session.refreshPushSenderHealth()
        }
        .confirmationDialog(
            "Merge Extra Threads?",
            isPresented: $confirmSimpleMerge,
            titleVisibility: .visible
        ) {
            Button("Merge All Threads") {
                Task { _ = await session.updateConversationMode("simple", mergeThreads: true) }
            }
            Button("Keep Extra Threads Hidden") {
                Task { _ = await session.updateConversationMode("simple") }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Simple is one conversation per bot.\u{00A0} Merge extra threads into that conversation, or keep them saved but hidden.")
        }
    }

    private var showToolCallsBinding: Binding<Bool> {
        Binding(
            get: { session.config?.features?.showsToolCalls ?? true },
            set: { next in
                Task { _ = await session.updateFeatures(showToolCalls: next) }
            }
        )
    }

    private var summarizeToolCallsBinding: Binding<Bool> {
        Binding(
            get: { session.config?.features?.summarizesToolCalls ?? true },
            set: { next in
                Task { _ = await session.updateFeatures(summarizeToolCalls: next) }
            }
        )
    }

    private func loadSettingsExtras() async {
        guard session.connection != nil else {
            engines = []
            profileName = ""
            profileEmail = ""
            roomTimeoutText = "5"
            return
        }
        if let status = await session.configStatus() {
            profileName = status.profile?.name ?? ""
            profileEmail = status.profile?.email ?? ""
            roomTimeoutText = String(status.rooms?.turnTimeoutMinutes ?? 5)
        }
        loadingEngines = true
        let fetched = await session.instances()
        engines = fetched.filter(\.isEnabled)
        loadingEngines = false
    }

    private func saveProfile() async {
        let name = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = profileEmail.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        _ = await session.updateProfile(name: name, email: email)
    }

    private func saveRoomTimeout() async {
        let trimmed = roomTimeoutText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let minutes = Int(trimmed), minutes >= 1, minutes <= 1_440 else {
            roomTimeoutError = "Enter a whole number from 1 to 1,440."
            return
        }
        roomTimeoutError = ""
        savingRoomTimeout = true
        if await session.updateRoomTurnTimeout(minutes: minutes) == nil {
            roomTimeoutError = "Could not save the channel turn limit."
        } else {
            roomTimeoutText = String(minutes)
        }
        savingRoomTimeout = false
    }

    private var workspaceFooter: String {
        session.config?.isProjectsMode == true
            ? "Projects hides named bots.  That word is a category that any number of threads can sit under."
            : "Simple is one conversation per bot.  That word is a group thread invited bots and you can all write in."
    }

    private var notificationsAreEnabled: Bool {
        switch session.notificationAuthorization {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    private var notificationAccessibilityHint: String {
        if notificationsAreEnabled { return "Notifications are enabled" }
        if session.notificationAuthorization == .denied { return "Opens iPhone Settings" }
        return "Asks for permission to send notifications"
    }

    private var notificationRow: some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: "bell.fill", color: .red)
            Text("Notifications")
                .foregroundStyle(.primary)
            Spacer()
            if enablingNotifications {
                ProgressView()
                    .controlSize(.small)
            } else {
                Text(session.notificationStatusText)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// The push-sender health row.  Copy follows #389: a single line that
    /// tells the owner what the sidecar reported, optionally with a
    /// detail line under it.  Loading and "not reported" are visibly
    /// different from "configured" so a missing key is not silently
    /// rendered as healthy.
    private var pushHealthRow: some View {
        HStack(alignment: .top, spacing: 12) {
            SettingsIcon(symbol: "antenna.radiowaves.left.and.right", color: .green)
            VStack(alignment: .leading, spacing: 4) {
                Text(pushHealthPrimary)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                if let detail = pushHealthDetail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if refreshingPushHealth {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Refreshes when pulled")
        .task(id: session.connection?.id) {
            // Re-fetch when the user pairs a new computer: the row's value
            // belongs to the active pairing, not whatever was cached at
            // launch.
            await session.refreshPushSenderHealth()
        }
    }

    /// One-line summary that fits in the row.  The detail line carries
    /// the dropped/failed counts when there is anything worth surfacing.
    private var pushHealthPrimary: String {
        if session.pushSenderHealthNotReported {
            return PushSenderHealthView.notReported
        }
        if let health = session.pushSenderHealth {
            return PushSenderHealthView.summary(health)
        }
        return "Checking closed-app delivery…"
    }

    private var pushHealthDetail: String? {
        guard let health = session.pushSenderHealth else { return nil }
        return PushSenderHealthView.detail(health)
    }

    /// Short footer that explains the row without repeating the summary.
    /// "Not reported" deserves its own copy because it points the user at
    /// a software update rather than at a setting on their computer.
    private var pushHealthFooter: String {
        if session.pushSenderHealthNotReported {
            return "This computer's BotFleet is older than the version that reports this row.  Update BotFleet on your computer to see it."
        }
        return "Pull down to refresh.  The status reflects what your computer last reported."
    }

    private var statusText: String { session.status.settingsText }
}

private struct ComputerSettingsRow: View {
    let name: String
    let status: String
    let connected: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(MausPalette.color("blue").opacity(0.14))
                    .frame(width: 38, height: 38)
                Image(systemName: "laptopcomputer")
                    .foregroundStyle(MausPalette.color("blue"))
            }
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(name)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle()
                        .fill(connected ? Color.green : Color.secondary)
                        .frame(width: 7, height: 7)
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct SettingsIcon: View {
    let symbol: String
    let color: Color

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(color, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct ConnectionSecurityView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var editingAddress = false
    @State private var addressText = ""
    @State private var showingFullAddress = false
    @State private var copiedAddress = false
    @State private var refreshing = false

    var body: some View {
        Form {
            if let connection = session.connection {
                Section {
                    HStack(spacing: 14) {
                        ProfileAvatar(name: connection.name, size: 46)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(connection.name)
                                .font(.headline)
                            Label(session.status.settingsText,
                                  systemImage: session.status == .live ? "checkmark.circle.fill" : "circle.dotted")
                                .font(.subheadline)
                                .foregroundStyle(session.status == .live ? Color.green : Color.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }

                Section {
                    DisclosureGroup("Connection details") {
                        VStack(alignment: .leading, spacing: 12) {
                            Group {
                                if showingFullAddress {
                                    Text(connection.displayAddress)
                                        .textSelection(.enabled)
                                } else {
                                    Text(shortened(connection.displayAddress))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)

                            HStack(spacing: 16) {
                                Button(showingFullAddress ? "Hide full address" : "Show full address") {
                                    showingFullAddress.toggle()
                                }
                                Button(copiedAddress ? "Copied" : "Copy") {
                                    UIPasteboard.general.string = connection.displayAddress
                                    copiedAddress = true
                                    Task {
                                        try? await Task.sleep(for: .seconds(2))
                                        copiedAddress = false
                                    }
                                }
                            }
                            .font(.subheadline.weight(.medium))
                        }
                        .padding(.top, 10)
                    }

                    Button("Edit address") {
                        addressText = connection.displayAddress
                        editingAddress = true
                    }
                }

                Section("Troubleshooting") {
                    Text(troubleshootingText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    Button {
                        refreshing = true
                        Task {
                            await session.refresh()
                            refreshing = false
                        }
                    } label: {
                        HStack {
                            Text("Try reconnecting")
                            if refreshing {
                                Spacer()
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .disabled(refreshing)
                }

                Section {
                    Button("Remove connection from this iPhone", role: .destructive) {
                        confirmingSignOut = true
                    }
                }
            } else {
                ContentUnavailableView("No computer connected", systemImage: "laptopcomputer.slash")
            }
        }
        .navigationTitle("Connection & Security")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Edit address", isPresented: $editingAddress) {
            TextField("Computer address", text: $addressText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") {
                if !session.updateAddress(addressText) {
                    session.actionError = "That address doesn't look right. Copy it from Phone settings and try again."
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Use the address shown in Phone settings on your computer. Your pairing is kept.")
        }
        .confirmationDialog(
            "Remove this connection?",
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button("Remove from this iPhone", role: .destructive) {
                session.signOut()
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the connection from this iPhone only. It does not revoke this phone on your Mac. To remove Mac-side access, open BotFleet → Settings → Phone and remove this device.")
        }
    }

    private var troubleshootingText: String {
        switch session.status {
        case .live:
            return "This computer is connected and responding normally."
        case .connecting:
            return "BotFleet is trying the saved connection automatically."
        case let .offline(reason):
            return reason
        case .unauthorized:
            return "This phone was removed from the computer. Pair it again to reconnect."
        case .unpaired:
            return "This phone is not paired with a computer."
        }
    }

    private func shortened(_ address: String) -> String {
        guard address.count > 14 else { return address }
        let leadingCount = min(20, max(8, address.count - 8))
        return "\(address.prefix(leadingCount))…\(address.suffix(6))"
    }
}

private extension Session.Status {
    var settingsText: String {
        switch self {
        case .live: return "Connected"
        case .connecting: return "Connecting…"
        case .unpaired: return "Not paired"
        case .unauthorized: return "Needs pairing"
        case .offline: return "Offline"
        }
    }
}

/// The custom room word, in both forms.
///
/// Two fields rather than one because English plurals are not reliably an
/// added "s".  The plural follows the singular until it is edited by hand,
/// so the ordinary case is still one word to type.
struct CustomRoomTermFields: View {
    @ObservedObject var session: Session
    @State private var singular = ""
    @State private var plural = ""
    @State private var pluralEdited = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Enter both forms.  The plural is not always just an added \"s\", so it has its own box — Category and Categories.")
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                TextField("App", text: $singular)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .onChange(of: singular) { _, next in
                        if !pluralEdited { plural = Self.suggestPlural(next) }
                    }
                    .onSubmit(save)
                TextField("Apps", text: $plural)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .onChange(of: plural) { _, _ in pluralEdited = true }
                    .onSubmit(save)
            }
            Button("Save", action: save)
                .disabled(singular.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .onAppear {
            singular = session.config?.roomLabels?.singular ?? ""
            plural = session.config?.roomLabels?.plural ?? ""
            pluralEdited = !plural.isEmpty
        }
    }

    private func save() {
        let one = singular.trimmingCharacters(in: .whitespaces)
        guard !one.isEmpty else { return }
        let many = plural.trimmingCharacters(in: .whitespaces)
        let labels = RoomLabels(singular: one, plural: many.isEmpty ? Self.suggestPlural(one) : many)
        Task { _ = await session.updateTerminology("custom", custom: labels) }
    }

    /// Mirrors `suggestPlural` in shared/terminology.ts.  It is a pre-fill,
    /// never a rule: whatever is left in the field is what gets stored.
    static func suggestPlural(_ singular: String) -> String {
        let word = singular.trimmingCharacters(in: .whitespaces)
        guard !word.isEmpty else { return "" }
        let lower = word.lowercased()
        let letters = word.filter(\.isLetter)
        let shouting = letters.count > 1 && letters == letters.uppercased()
        func suffix(_ value: String) -> String { shouting ? value.uppercased() : value }
        if lower.hasSuffix("s") || lower.hasSuffix("x") || lower.hasSuffix("z")
            || lower.hasSuffix("ch") || lower.hasSuffix("sh") {
            return word + suffix("es")
        }
        if lower.hasSuffix("y"), let before = lower.dropLast().last, !"aeiou".contains(before) {
            return word.dropLast() + suffix("ies")
        }
        if lower.hasSuffix("fe") { return word.dropLast(2) + suffix("ves") }
        if lower.hasSuffix("f"), !lower.hasSuffix("ff") { return word.dropLast() + suffix("ves") }
        return word + suffix("s")
    }
}

private struct EngineChip: View {
    let instance: Instance

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(instance.displayName ?? instance.instanceId)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Text(instance.snapshot.engineStatusLabel)
                .font(.caption)
                .foregroundStyle(statusColor)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.06), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private var statusColor: Color {
        switch instance.snapshot.engineStatusLabel {
        case "Ready": return .green
        case "Sign in": return .orange
        default: return .secondary
        }
    }
}

private struct EngineSetupSheet: View {
    let instance: Instance
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(instance.displayName ?? instance.instanceId)
                    .font(.title2.weight(.semibold))
                Text(instance.snapshot.engineStatusLabel)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Text("Finish setup in the Mac app.")
                    .font(.body)
                    .foregroundStyle(.primary)
                Spacer()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
            .navigationTitle("Engine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
