// Notification categories and action routing.
//
// `UNNotificationCategory`/`UNNotificationAction` are UserNotifications
// types, not UIKit, so they live here rather than in the app target: the
// category the app registers at launch and the routing a tapped action goes
// through are the same two facts, and keeping both in one place — tested
// with `swift test`, no simulator needed — is what stops registration and
// routing from quietly drifting apart.
import Foundation
import UserNotifications

/// The two categories a BotFleet notification can carry, matching
/// `NotificationFrame.isBlocking` in Frames.swift: a bot blocked on you gets
/// the approval actions, everything else gets only Open.
public enum NotificationCategoryIdentifier {
    public static let approval = "BOTFLEET_APPROVAL"
    public static let update = "BOTFLEET_UPDATE"
}

/// Action identifiers registered on those categories.  Shared by
/// registration and routing so the two lists cannot fall out of step.
public enum NotificationActionIdentifier {
    public static let approve = "BOTFLEET_APPROVE"
    public static let deny = "BOTFLEET_DENY"
    public static let open = "BOTFLEET_OPEN"
}

/// Builds the categories this app registers with `UNUserNotificationCenter`.
/// A pure factory — no `UNUserNotificationCenter` involved — so the action
/// set is testable without a simulator.
public enum NotificationCategories {
    public static func all() -> Set<UNNotificationCategory> {
        // Approving is a consequential action taken straight from the lock
        // screen without opening the app, so require the device be unlocked
        // first; denying is the safe direction and does not need that gate.
        let approve = UNNotificationAction(
            identifier: NotificationActionIdentifier.approve,
            title: "Approve",
            options: [.authenticationRequired]
        )
        let deny = UNNotificationAction(
            identifier: NotificationActionIdentifier.deny,
            title: "Deny",
            options: [.destructive]
        )
        let open = UNNotificationAction(
            identifier: NotificationActionIdentifier.open,
            title: "Open",
            options: [.foreground]
        )
        let approval = UNNotificationCategory(
            identifier: NotificationCategoryIdentifier.approval,
            actions: [approve, deny, open],
            intentIdentifiers: [],
            options: []
        )
        let update = UNNotificationCategory(
            identifier: NotificationCategoryIdentifier.update,
            actions: [open],
            intentIdentifiers: [],
            options: []
        )
        return [approval, update]
    }
}

/// What a notification response should do next, decided purely from the
/// action identifier and the frame's `userInfo` — no `UNUserNotificationCenter`
/// involved, so this is trivial and honest to unit test.
public enum NotificationActionRoute: Equatable, Sendable {
    /// Send the approval answer for this target — no navigation.
    case approve(NotificationTarget)
    /// Send the deny answer for this target — no navigation.
    case deny(NotificationTarget)
    /// Bring the app to this target's thread — a tap, or the explicit
    /// Open action.
    case open(NotificationTarget)
    /// The user dismissed the notification without acting.
    case dismiss
    /// An action arrived without the ids it needs — a malformed or stale
    /// payload — or an identifier this app does not register.
    case ignore
}

public extension NotificationTarget {
    /// Route a `UNNotificationResponse`, already unpacked into its two
    /// primitive fields, to what should happen next.  Local and remote
    /// notifications carry the same top-level `threadId`/`botId` keys (see
    /// `fromRemoteUserInfo`), so this one function covers both delivery
    /// paths and both categories.
    static func actionRoute(
        actionIdentifier: String,
        userInfo: [AnyHashable: Any]
    ) -> NotificationActionRoute {
        switch actionIdentifier {
        case NotificationActionIdentifier.approve:
            return fromRemoteUserInfo(userInfo).map(NotificationActionRoute.approve) ?? .ignore
        case NotificationActionIdentifier.deny:
            return fromRemoteUserInfo(userInfo).map(NotificationActionRoute.deny) ?? .ignore
        case NotificationActionIdentifier.open, UNNotificationDefaultActionIdentifier:
            return fromRemoteUserInfo(userInfo).map(NotificationActionRoute.open) ?? .ignore
        case UNNotificationDismissActionIdentifier:
            return .dismiss
        default:
            return .ignore
        }
    }
}
