import Foundation

/// Shared container used to hand pairing state from the legacy
/// `app.botfleet` install to the renamed `app.botfleet.ios` install.
///
/// Both apps must entitle `group.app.botfleet`. The legacy app still has to
/// *export* (write) into this suite before the rename can finish the
/// handoff; this module is the import + dual-compat read path the renamed
/// app needs so that export can complete the transition once it lands.
public enum CompanionAppGroup {
    public static let suiteName = "group.app.botfleet"

    /// Keychain access group matching `$(AppIdentifierPrefix)group.app.botfleet`
    /// in the iOS entitlements (team `CC8UTF7ATG`).
    public static let keychainAccessGroup = "CC8UTF7ATG.group.app.botfleet"
}

/// Where the restorable companion connection blob lives, and how a renamed
/// install reads it without losing a same-container upgrade path.
public enum CompanionConnectionStore {
    public static let connectionKey = "companion.connection"

    /// Suite first (cross-bundle import), then `UserDefaults.standard`
    /// (same-container dual-compat). Returns which store held the data so
    /// callers can promote a standard-only value into the shared suite.
    public static func loadConnectionData(
        shared: UserDefaults? = UserDefaults(suiteName: CompanionAppGroup.suiteName),
        standard: UserDefaults = .standard
    ) -> (data: Data, source: Source)? {
        if let data = shared?.data(forKey: connectionKey), !data.isEmpty {
            return (data, .shared)
        }
        if let data = standard.data(forKey: connectionKey), !data.isEmpty {
            return (data, .standard)
        }
        return nil
    }

    /// Always write the shared suite when available so a future sibling
    /// install can import; also mirror into standard for same-container
    /// relaunches that never see the suite.
    public static func saveConnectionData(
        _ data: Data?,
        shared: UserDefaults? = UserDefaults(suiteName: CompanionAppGroup.suiteName),
        standard: UserDefaults = .standard
    ) {
        if let data {
            shared?.set(data, forKey: connectionKey)
            standard.set(data, forKey: connectionKey)
        } else {
            shared?.removeObject(forKey: connectionKey)
            standard.removeObject(forKey: connectionKey)
        }
    }

    /// After a successful standard-only restore, copy into the suite so the
    /// next launch (or a sibling install that gains export) sees one source.
    public static func promoteStandardToSharedIfNeeded(
        source: Source,
        data: Data,
        shared: UserDefaults? = UserDefaults(suiteName: CompanionAppGroup.suiteName)
    ) {
        guard source == .standard else { return }
        shared?.set(data, forKey: connectionKey)
    }

    public enum Source: Equatable, Sendable {
        case shared
        case standard
    }
}

/// Custom URL schemes the companion registers. The renamed iOS app owns
/// `botfleet-ios` so it is not racing the legacy `app.botfleet` install for
/// `botfleet://` delivery; legacy stays registered as a fallback so older
/// QR codes and Live Activity taps still open when iOS routes them here.
public enum CompanionURLScheme {
    public static let primary = "botfleet-ios"
    public static let legacy = "botfleet"

    public static let all: [String] = [primary, legacy]

    public static func accepts(_ scheme: String?) -> Bool {
        guard let scheme else { return false }
        let lowered = scheme.lowercased()
        return lowered == primary || lowered == legacy
    }
}
