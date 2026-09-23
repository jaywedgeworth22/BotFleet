// Closed-app wake: how healthy the sidecar's APNs sender looks right now.
//
// Mirrors `PushSenderHealth` in `companion/src/apns.ts`.  The shape lives
// here rather than in Models.swift because it is a sidecar-owned route,
// not a harness one — the harness has no concept of push delivery.  Counts
// and Apple's own status strings only; nothing derived from the signing key.
import Foundation

public struct PushSenderHealth: Codable, Hashable, Sendable {
    /// Whether a usable .p8 has been found yet.
    public let configured: Bool
    /// Production or sandbox APNs, once configured.
    public let production: Bool?
    /// Paired devices holding a push token right now.
    public let tokensRegistered: Int
    public let sent: Int
    public let failed: Int
    /// Milliseconds since the Unix epoch; matches what the sidecar emits.
    public let lastSentAt: Double?
    public let lastErrorAt: Double?
    /// Apple's status plus its reason, e.g. `403 ExpiredProviderToken`.
    public let lastError: String?
    /// Set when Apple refused the signing key itself.  Sending is off until
    /// the key file changes — a fresh signature from the same key cannot
    /// help.
    public let keyRejected: String?
    /// Notifications dropped because a device's queue was already full.
    public let dropped: Int
    /// Notifications skipped while the sidecar's circuit breaker was open —
    /// Apple's push service was unreachable, not a full queue.  Optional so
    /// an older sidecar that does not send the field still decodes.
    public let circuitDropped: Int?

    public init(
        configured: Bool,
        production: Bool?,
        tokensRegistered: Int,
        sent: Int,
        failed: Int,
        lastSentAt: Double?,
        lastErrorAt: Double?,
        lastError: String?,
        keyRejected: String?,
        dropped: Int,
        circuitDropped: Int? = nil
    ) {
        self.configured = configured
        self.production = production
        self.tokensRegistered = tokensRegistered
        self.sent = sent
        self.failed = failed
        self.lastSentAt = lastSentAt
        self.lastErrorAt = lastErrorAt
        self.lastError = lastError
        self.keyRejected = keyRejected
        self.dropped = dropped
        self.circuitDropped = circuitDropped
    }
}

/// Renders `PushSenderHealth` as the Settings row the issue calls for.
///
/// Pure: takes a clock so tests do not need to freeze the system date.
/// Strings follow the copy in #389 — what a non-technical owner can act
/// on without a sentence about Apple's status codes.
public enum PushSenderHealthView {
    /// The primary status line for the Settings row.
    ///
    /// `now` lets tests pin time, and `relativeDescription` lets them
    /// pin the locale-dependent phrase — production callers omit both.
    public static func summary(
        _ health: PushSenderHealth,
        now: Date = Date(),
        relativeDescription: (Date, Date) -> String = defaultRelativeDescription
    ) -> String {
        // No key: a closed app will not be woken.  This is the one state
        // the user can actually fix by themselves, so it gets its own line.
        if !health.configured {
            return "No signing key on your computer — a closed app will not be woken."
        }
        if let rejected = health.keyRejected, !rejected.isEmpty {
            // Apple's reason is technical, but it tells the owner whether
            // to ask Apple or rotate the key, so surface it verbatim and
            // explain the fix in plain English below.
            return "\(rejected) — the key file needs replacing."
        }
        if let sentAt = health.lastSentAt {
            let sentDate = Date(timeIntervalSince1970: sentAt / 1000)
            let relative = relativeDescription(sentDate, now)
            if let lastError = health.lastError, !lastError.isEmpty {
                return "Closed-app notifications: On — last push \(relative); last error \(lastError)"
            }
            return "Closed-app notifications: On — last push \(relative)"
        }
        if let lastError = health.lastError, !lastError.isEmpty {
            return "Closed-app notifications: configured — last error \(lastError)"
        }
        return "Closed-app notifications: configured — no pushes sent yet"
    }

    /// Secondary line for `dropped`, `circuitDropped` and a recent `failed`
    /// count.  Returns nil when there is nothing worth surfacing beyond the
    /// primary line.  Queue-full drops and circuit-breaker skips get their
    /// own wording: an APNs outage must not read as a full local queue.
    public static func detail(_ health: PushSenderHealth) -> String? {
        var parts: [String] = []
        if health.dropped > 0 {
            parts.append("\(health.dropped) dropped (queue full)")
        }
        if let skipped = health.circuitDropped, skipped > 0 {
            parts.append("\(skipped) skipped (Apple push service unreachable)")
        }
        if health.failed > 0 {
            parts.append("\(health.failed) failed")
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// The "not reported by this computer" line for an older sidecar.
    public static let notReported = "Closed-app notifications: status not reported by this computer."

    public static let defaultRelativeDescription: (Date, Date) -> String = { past, now in
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: past, relativeTo: now)
    }
}
