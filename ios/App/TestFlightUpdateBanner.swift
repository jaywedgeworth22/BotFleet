// The "a newer TestFlight build exists" notice: on launch and on becoming
// active, rate-limited to once an hour, this phone checks the fleet's
// published manifest and offers to open TestFlight when it is behind.
//
// Deliberately separate from `Session`: this has nothing to do with the
// paired Mac and must work identically whether or not one is connected, so
// it owns its own tiny bit of `UserDefaults` state instead of borrowing
// Session's.
import CompanionCore
import SwiftUI
import UIKit

/// Drives the once-an-hour manifest check and remembers what has already
/// been dismissed, so relaunching the app does not resurface a banner the
/// person already closed for that exact build.
@MainActor
final class TestFlightUpdateMonitor: ObservableObject {
    @Published private(set) var available: AppBuildInfo?
    @Published private(set) var dismissed = false

    private let fetcher: VersionManifestFetcher
    private let running: AppBuildInfo
    private let defaults: UserDefaults

    private enum Keys {
        static let lastCheckedAt = "companion.testflight.lastCheckedAt"
        static let dismissedBuild = "companion.testflight.dismissedBuild"
    }

    init(
        fetcher: VersionManifestFetcher = VersionManifestFetcher(),
        running: AppBuildInfo = TestFlightUpdateMonitor.runningBuild(),
        defaults: UserDefaults = .standard
    ) {
        self.fetcher = fetcher
        self.running = running
        self.defaults = defaults
    }

    var shouldShowBanner: Bool { available != nil && !dismissed }

    /// Reads the running app's own stamped version — real `Info.plist`
    /// values in production, and whatever a test constructs otherwise.
    static func runningBuild(bundle: Bundle = .main) -> AppBuildInfo {
        AppBuildInfo(
            marketingVersion: bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0",
            build: bundle.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        )
    }

    /// Called on launch and every time the app becomes active.  Fails
    /// silently offline or on any other error — this must never be the
    /// reason someone sees an error dialog for a feature they did not ask
    /// about, and a failed check today does not block one at the next
    /// opportunity.
    func checkIfDue(now: Date = Date()) async {
        let last = defaults.object(forKey: Keys.lastCheckedAt) as? Date
        guard TestFlightCheckThrottle.isDue(lastCheckedAt: last, now: now) else { return }
        defaults.set(now, forKey: Keys.lastCheckedAt)
        do {
            let manifest = try await fetcher.fetch()
            guard let candidate = TestFlightUpdateCheck.availableUpdate(in: manifest, running: running) else {
                available = nil
                return
            }
            available = candidate
            // A build newer than the one already dismissed reopens the
            // banner — dismissing "1.0.30" must not silently swallow "1.0.31".
            if defaults.string(forKey: Keys.dismissedBuild) != candidate.build {
                dismissed = false
            }
        } catch {
            // offline, DNS hiccup, GitHub Pages blip — none of it is worth
            // surfacing for a feature nobody asked to see right now
        }
    }

    func dismiss() {
        guard let available else { return }
        dismissed = true
        defaults.set(available.build, forKey: Keys.dismissedBuild)
    }
}

/// The dismissible strip itself.  Placed as a `safeAreaInset` at the root so
/// it pushes content down rather than covering it, the way the rest of the
/// app's transient banners behave.
struct TestFlightUpdateBanner: View {
    @ObservedObject var monitor: TestFlightUpdateMonitor

    var body: some View {
        if let available = monitor.available, monitor.shouldShowBanner {
            HStack(spacing: 12) {
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 1) {
                    Text("A newer TestFlight build (\(available.marketingVersion) (\(available.build))) is available")
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button("Open TestFlight") {
                    openTestFlight()
                }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                Button {
                    monitor.dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.thinMaterial)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// `itms-beta://` opens TestFlight directly when it is installed.  There
    /// is no reliable, undocumented-scheme-free way to deep link straight to
    /// this app's own beta page from just an App Store id — a proper
    /// `testflight.apple.com/join/...` link needs the invite code, which the
    /// manifest does not carry — so this opens TestFlight itself and falls
    /// back to TestFlight's own App Store page when it is not installed,
    /// exactly as the brief asks.
    private func openTestFlight() {
        guard let testFlight = URL(string: "itms-beta://") else { return }
        UIApplication.shared.open(testFlight, options: [:]) { opened in
            guard !opened, let appStore = URL(string: "https://apps.apple.com/app/testflight/id899247664") else { return }
            UIApplication.shared.open(appStore)
        }
    }
}
