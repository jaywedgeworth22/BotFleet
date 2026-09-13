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

// MARK: - Resolving which request Approve/Deny actually answers

/// The minimum slice of a pending card an approval decision needs — kept
/// separate from `OptionCard`/`Message` so `ApprovalResolver` never has to
/// know how a card is stored, only what it means.
public struct PendingApproval: Equatable, Sendable {
    public let threadId: String
    public let requestId: String
    public let isPermission: Bool

    public init(threadId: String, requestId: String, isPermission: Bool) {
        self.threadId = threadId
        self.requestId = requestId
        self.isPermission = isPermission
    }
}

/// What a notification's Approve/Deny action should actually do.
public enum ApprovalResolution: Equatable, Sendable {
    /// Answer this exact request.  `isPermission` decides allow/deny
    /// behavior versus a free-text answer.
    case answer(requestId: String, isPermission: Bool)
    /// No single pending request can be identified with confidence —
    /// bring the app to the thread instead of guessing which one the user
    /// meant.
    case openApp
}

/// Decides which pending request an Approve/Deny notification action
/// answers.  Pure and total on purpose: PR #383's review found that the
/// code this replaced picked a card by "newest pending on this thread" —
/// which is silently the WRONG card the moment two requests are open on
/// one thread, or absent entirely on a cold-launched process.  A Deny on a
/// question, misrouted to a permission card, is sent as a permission deny
/// with no message; the mirror case sends `behavior: "answer"` for a
/// permission card, which the harness's proxy fails closed with no audit
/// row.  Neither is safe to guess past — `swift test` pins the rule here
/// instead.
public enum ApprovalResolver {
    public static func resolve(
        threadId: String,
        requestId: String?,
        kind: String?,
        pending: [PendingApproval]
    ) -> ApprovalResolution {
        if let requestId {
            // A card matching both the thread AND the exact request id
            // knows its own `isPermission` for certain.  A cold launch, or
            // an id that only exists on a different thread, must never
            // borrow an unrelated card's answer shape — `kind` is
            // authoritative there: the harness builds it as
            // `permission ? "approval" : "question"`.
            let isPermission = pending.first { $0.threadId == threadId && $0.requestId == requestId }?.isPermission
                ?? (kind == "approval")
            return .answer(requestId: requestId, isPermission: isPermission)
        }
        // An older harness names no request at all.  Guessing "the newest
        // pending card on this thread" is exactly the bug above — safe
        // only when there is exactly one candidate to guess.
        let onThread = pending.filter { $0.threadId == threadId }
        guard onThread.count == 1, let only = onThread.first else { return .openApp }
        return .answer(requestId: only.requestId, isPermission: only.isPermission)
    }
}
