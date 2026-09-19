// Closed-app push health in iOS Settings.  The paired Mac already renders
// this from the same `/api/companion/push-health` response; the phone had
// no consumer, so a phone that is paired, reachable, and simply never
// buzzes looked exactly like a quiet fleet.  This row is the phone-side
// answer, kept small on purpose — it should not become a debug surface.
//
// Field semantics match `companion/src/apns.ts` `PushSenderHealth`.  Every
// field is either a count, a timestamp, or a status string Apple sent us;
// nothing derived from the signing key crosses that boundary.
import CompanionCore
import SwiftUI

struct PushHealthSection: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        Section {
            if let health = session.pushSenderHealth {
                statusRow(health)
                if let timestamp = health.lastSentAt {
                    lastSentRow(timestamp)
                }
                if let reason = health.keyRejected {
                    keyRejectedRow(reason)
                } else if let lastError = health.lastError, let lastErrorAt = health.lastErrorAt {
                    lastErrorRow(lastError: lastError, at: lastErrorAt)
                }
                if health.dropped > 0 {
                    droppedRow(health.dropped)
                }
            } else if session.pushSenderHealthUnsupported {
                unsupportedRow
            } else if session.connection == nil {
                notPairedRow
            } else {
                loadingRow
            }
        } header: {
            Text("Closed-App Notifications")
        } footer: {
            Text(footerCopy)
        }
        .task {
            // Only fetch when there is something to fetch from.  A user who
            // is not yet paired has no `client`, and the row already says so.
            if session.connection != nil {
                await session.loadPushSenderHealth()
            }
        }
    }

    // MARK: - Rows

    private func statusRow(_ health: PushSenderHealth) -> some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: statusSymbol(health).name,
                         color: statusSymbol(health).color)
            VStack(alignment: .leading, spacing: 3) {
                Text(statusTitle(health))
                    .foregroundStyle(.primary)
                Text(statusSubtitle(health))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func lastSentRow(_ timestamp: Int) -> some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: "paperplane", color: .blue)
            VStack(alignment: .leading, spacing: 3) {
                Text("Last push sent")
                    .foregroundStyle(.primary)
                Text(Self.relativeTime(ms: timestamp))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func keyRejectedRow(_ reason: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                SettingsIcon(symbol: "key.slash", color: .red)
                Text("Apple refused the signing key")
                    .foregroundStyle(.primary)
            }
            Text(reason)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 40)
            Text("Replace the .p8 file on your computer — sending is off until then.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 40)
        }
    }

    private func lastErrorRow(lastError: String, at: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                SettingsIcon(symbol: "exclamationmark.triangle", color: .orange)
                Text("Recent error")
                    .foregroundStyle(.primary)
            }
            Text(lastError)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 40)
            Text(Self.relativeTime(ms: at))
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .padding(.leading, 40)
        }
    }

    private func droppedRow(_ dropped: Int) -> some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: "tray.full", color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text("Dropped (queue full)")
                    .foregroundStyle(.primary)
                Text("\(dropped) \(dropped == 1 ? "notification" : "notifications") replaced because a device queue was full.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var unsupportedRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Not reported by this computer", systemImage: "info.circle")
                .foregroundStyle(.secondary)
            Text("This computer is running an older BotFleet that does not report closed-app push health.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Retry") {
                Task { await session.loadPushSenderHealth() }
            }
        }
    }

    private var notPairedRow: some View {
        HStack(spacing: 12) {
            SettingsIcon(symbol: "antenna.radiowaves.left.and.right.slash", color: .secondary)
            Text("Pair with a computer to see push delivery health.")
                .foregroundStyle(.secondary)
        }
    }

    private var loadingRow: some View {
        HStack {
            Text("Checking push delivery…")
                .foregroundStyle(.secondary)
            Spacer()
            ProgressView().controlSize(.small)
        }
    }

    // MARK: - Status shape

    /// The big status row maps the configured/rejected/failed/error axes
    /// down to one of a small set of headlines so the user never has to
    /// read JSON to know whether wakes are working.
    private func statusTitle(_ health: PushSenderHealth) -> String {
        if health.keyRejected != nil { return "Signing key rejected" }
        if !health.configured { return "No signing key on your computer" }
        if health.failed > 0 && health.sent == 0 { return "All pushes failing" }
        if health.failed > health.sent / 2 && health.sent > 5 { return "More pushes failing than succeeding" }
        return "Closed-app notifications: On"
    }

    private func statusSubtitle(_ health: PushSenderHealth) -> String {
        if !health.configured { return "A closed app will not be woken." }
        let mode = health.production == true ? "production" : "sandbox"
        let counts = "\(health.sent) sent, \(health.failed) failed — \(mode) APNs."
        if health.tokensRegistered == 0 {
            return "\(counts)  No paired device has registered a push token yet."
        }
        if health.tokensRegistered == 1 {
            return "\(counts)  This phone is registered."
        }
        return "\(counts)  \(health.tokensRegistered) phones registered."
    }

    private func statusSymbol(_ health: PushSenderHealth) -> (name: String, color: Color) {
        if health.keyRejected != nil { return ("key.slash", .red) }
        if !health.configured { return ("key", .orange) }
        if health.failed > 0 && health.sent == 0 { return ("exclamationmark.octagon.fill", .red) }
        if health.failed > 0 { return ("exclamationmark.triangle.fill", .orange) }
        return ("checkmark.circle.fill", .green)
    }

    // MARK: - Footer copy

    /// The footer mirrors the row above — a single sentence that explains
    /// what this card is for, in the same voice as the rest of Settings.
    private var footerCopy: String {
        if session.pushSenderHealth == nil && session.pushSenderHealthUnsupported {
            return "Closed-app wake depends on the paired computer's BotFleet version.  An older build cannot report this status."
        }
        if session.pushSenderHealth == nil && session.connection == nil {
            return "This card reports whether killed-app wake is actually working on your paired computer."
        }
        return "Counts and timestamps only — Apple sends the status strings, the sidecar never reads the signing key."
    }

    // MARK: - Formatting

    /// The sidecar stamps both `lastSentAt` and `lastErrorAt` as
    /// milliseconds since the Unix epoch.  Show the same shape on iOS:
    /// a short "X minutes ago" with a fallback for the rare case the
    /// timestamp is missing or zero.
    private static func relativeTime(ms: Int) -> String {
        guard ms > 0 else { return "never" }
        let interval = TimeInterval(ms) / 1000
        let date = Date(timeIntervalSince1970: interval)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
