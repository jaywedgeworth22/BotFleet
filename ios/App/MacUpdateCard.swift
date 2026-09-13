// The Mac Update card: whether the paired computer's own BotFleet is up to
// date, and a button to install a newer build without touching the laptop.
//
// The install itself is entirely the harness's `/api/update/*` transaction —
// the same one `scripts/update-botfleet-mac.mjs` runs locally (see
// `docs/rollouts/2026-09-12-safe-mac-updater.md`).  This card only starts it
// and narrates `state.macUpdateStatus`, whether that came from the fetch on
// appear or a live `update.status` stream event landing in the background.
import CompanionCore
import SwiftUI

struct MacUpdateSection: View {
    @EnvironmentObject private var session: Session
    @State private var checking = false
    @State private var installing = false
    @State private var confirmingInstall = false
    /// The harness's own reason the last `runUpdate()` refused (a 409) —
    /// shown right here rather than only in the app-wide error alert, since
    /// it is a normal, expected answer ("an update is already running"),
    /// not a failure worth interrupting the screen for.
    @State private var installError: String?

    private var status: MacUpdateStatus? { session.state.macUpdateStatus }

    var body: some View {
        Section {
            if let status {
                installedRow(status)
                availabilityRow(status)
                if let lastRun = status.lastRun, status.running == nil {
                    lastRunRow(lastRun)
                }
                actionsRow(status)
                if let installError {
                    Text(installError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            } else {
                HStack {
                    Text("Checking for updates…")
                        .foregroundStyle(.secondary)
                    Spacer()
                    ProgressView().controlSize(.small)
                }
            }
        } header: {
            Text("Mac Update")
        } footer: {
            if let status {
                VStack(alignment: .leading, spacing: 4) {
                    Text(Self.checkedAtText(status.checkedAt))
                    if status.running == nil, status.capabilities.canRun == false,
                       let reason = status.capabilities.reasons.first {
                        Text(reason)
                    }
                }
            }
        }
        .task { await session.loadMacUpdateStatus() }
        .confirmationDialog(
            "Install Mac Update?",
            isPresented: $confirmingInstall,
            titleVisibility: .visible
        ) {
            Button("Install Update") {
                Task { await startInstall() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The Mac app and its server restart during the update.  Continue?")
        }
    }

    // MARK: - Rows

    private func installedRow(_ status: MacUpdateStatus) -> some View {
        HStack(spacing: 12) {
            MacUpdateIcon(symbol: "laptopcomputer", color: .blue)
            Text("Installed")
                .foregroundStyle(.primary)
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(status.installed.version ?? "Unknown version")
                Text(Self.shortCommit(status.installed.sourceCommit))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func availabilityRow(_ status: MacUpdateStatus) -> some View {
        if let running = status.running {
            runningRow(running)
        } else if let available = status.available {
            availableRow(available)
        } else {
            HStack(spacing: 12) {
                MacUpdateIcon(symbol: "checkmark.circle.fill", color: .green)
                Text("Up to date")
                    .foregroundStyle(.primary)
                Spacer()
            }
        }
    }

    private func runningRow(_ running: MacUpdateRun) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                MacUpdateIcon(symbol: "arrow.triangle.2.circlepath", color: .orange)
                Text("Installing…")
                    .foregroundStyle(.primary)
                Spacer()
                ProgressView().controlSize(.small)
            }
            Text(running.step)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.leading, 40)
            if let progress = running.progress {
                ProgressView(value: min(max(progress, 0), 1))
                    .padding(.leading, 40)
            }
            if let lastLine = running.logTail.last {
                Text(lastLine)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(2)
                    .padding(.leading, 40)
            }
        }
    }

    private func availableRow(_ available: MacAvailableUpdate) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                MacUpdateIcon(symbol: "arrow.down.circle.fill", color: .green)
                Text("Update available: \(available.version ?? Self.shortCommit(available.sourceCommit)), \(Self.commitCount(available.aheadBy)) ahead")
                    .foregroundStyle(.primary)
                Spacer()
            }
            if !available.commits.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(available.commits.prefix(5), id: \.sha) { commit in
                        Text("•\u{00A0}\(commit.subject)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(.leading, 40)
            }
        }
    }

    private func lastRunRow(_ lastRun: MacUpdateLastRun) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Last update: \(Self.outcomeText(lastRun.outcome))")
                .font(.footnote)
                .foregroundStyle(Self.outcomeColor(lastRun.outcome))
            if lastRun.outcome != .verified {
                Text(lastRun.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func actionsRow(_ status: MacUpdateStatus) -> some View {
        HStack {
            Button {
                checking = true
                Task {
                    await session.checkForMacUpdate()
                    checking = false
                }
            } label: {
                if checking {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Check")
                }
            }
            .disabled(checking || installing || status.running != nil || !status.capabilities.canCheck)

            Spacer()

            Button("Install Update") {
                confirmingInstall = true
            }
            .buttonStyle(.borderedProminent)
            .disabled(
                installing || status.running != nil || status.available == nil
                    || !status.capabilities.canRun
            )
        }
    }

    private func startInstall() async {
        installing = true
        installError = await session.runMacUpdate()
        installing = false
    }

    // MARK: - Formatting

    private static func checkedAtText(_ checkedAt: String?) -> String {
        guard let checkedAt else { return "Not checked yet" }
        guard let date = ISO8601DateFormatter().date(from: checkedAt) else {
            return "Checked \(checkedAt)"
        }
        return "Checked \(date.formatted(date: .abbreviated, time: .shortened))"
    }

    private static func shortCommit(_ sha: String) -> String {
        String(sha.prefix(7))
    }

    private static func commitCount(_ aheadBy: Int) -> String {
        "\(aheadBy) \(aheadBy == 1 ? "commit" : "commits")"
    }

    private static func outcomeText(_ outcome: MacUpdateOutcome) -> String {
        switch outcome {
        case .verified: return "Verified"
        case .rolledBack: return "Rolled back"
        case .failed: return "Failed"
        case .refused: return "Refused"
        case .unknown: return "Unknown"
        }
    }

    private static func outcomeColor(_ outcome: MacUpdateOutcome) -> Color {
        switch outcome {
        case .verified: return .green
        case .rolledBack, .failed: return .red
        case .refused, .unknown: return .secondary
        }
    }
}

private struct MacUpdateIcon: View {
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
