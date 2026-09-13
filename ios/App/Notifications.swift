import Foundation
import UserNotifications
import CompanionCore

/// The on-device notification surface. Delivery comes from live or replayed
/// companion frames, and from APNs when the sidecar wakes a killed app.
final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()
    private let center = UNUserNotificationCenter.current()
    /// Set by `Session`; kept as an id-only value so the notification layer
    /// does not know about SwiftUI navigation or mutable fleet state.
    var responseHandler: ((NotificationTarget) -> Void)?
    /// Thread currently on screen.  Banners for this id stay off; the
    /// bubble is already in the transcript.
    var viewingThreadId: String?
    /// Set by `Session`; answers Approve/Deny straight from a notification
    /// action, without opening the app.
    var approvalActionHandler: ((_ target: NotificationTarget, _ approve: Bool) async -> Void)?

    private override init() {
        super.init()
        center.delegate = self
        // Registered on every launch, before `RootView` appears and before
        // any notification (local or remote) can be delivered — see
        // `NotificationCategories` for why the set lives in CompanionCore.
        center.setNotificationCategories(NotificationCategories.all())
    }

    func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true
    }

    func deliver(_ notification: NotificationFrame, sequence: Int?) {
        guard NotificationFrame.shouldPresentBanner(
            threadId: notification.threadId,
            viewingThreadId: viewingThreadId
        ) else { return }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        content.categoryIdentifier = notification.isBlocking
            ? NotificationCategoryIdentifier.approval
            : NotificationCategoryIdentifier.update
        content.threadIdentifier = notification.threadId
        var userInfo: [AnyHashable: Any] = [
            "threadId": notification.threadId,
            "botId": notification.botId,
            "kind": notification.kind,
        ]
        // Only approval/question frames carry these — added conditionally
        // so an absent value never becomes an `NSNull` a reader has to
        // filter back out.
        if let requestId = notification.requestId { userInfo["requestId"] = requestId }
        if let tool = notification.tool { userInfo["tool"] = tool }
        content.userInfo = userInfo
        if notification.isBlocking { content.interruptionLevel = .timeSensitive }

        // A replay after a short disconnect must reconcile a missed alert,
        // but a repeated frame must not draw it twice.
        let identifier = "botfleet.\(notification.threadId).\(sequence.map(String.init) ?? notification.title)"
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    func setBadge(_ count: Int) {
        center.setBadgeCount(max(0, count))
    }

    /// A phone-local follow-up for when a notification action could not
    /// finish on its own — the original notification is already gone by
    /// the time the user would see this, so it needs its own banner.  Open
    /// only: this never carries Approve/Deny, so it cannot itself become
    /// the same "which request?" problem it exists to report.
    func deliverFollowUp(title: String, body: String, target: NotificationTarget) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = NotificationCategoryIdentifier.update
        content.threadIdentifier = target.threadId
        content.userInfo = ["threadId": target.threadId, "botId": target.botId]
        center.add(UNNotificationRequest(
            identifier: "botfleet.followup.\(target.threadId).\(UUID().uuidString)",
            content: content,
            trigger: nil
        ))
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let threadId = notification.request.content.threadIdentifier
        if NotificationFrame.shouldPresentBanner(threadId: threadId, viewingThreadId: viewingThreadId) {
            completionHandler([.banner, .list, .sound, .badge])
        } else {
            completionHandler([])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        switch NotificationTarget.actionRoute(actionIdentifier: response.actionIdentifier, userInfo: userInfo) {
        case let .approve(target):
            sendApprovalAction(target, approve: true, completionHandler: completionHandler)
        case let .deny(target):
            sendApprovalAction(target, approve: false, completionHandler: completionHandler)
        case let .open(target):
            // Covers both the explicit Open action and a plain tap
            // (`UNNotificationDefaultActionIdentifier`) — the app's existing
            // tap behaviour, unchanged.
            responseHandler?(target)
            completionHandler()
        case .dismiss, .ignore:
            completionHandler()
        }
    }

    /// Approve/deny send a network request, so — unlike a tap, which only
    /// touches in-memory navigation state — completion must wait for it:
    /// calling `completionHandler` early risks iOS suspending the process
    /// before the answer goes out.
    private func sendApprovalAction(
        _ target: NotificationTarget,
        approve: Bool,
        completionHandler: @escaping () -> Void
    ) {
        guard let approvalActionHandler else {
            completionHandler()
            return
        }
        Task {
            await approvalActionHandler(target, approve)
            completionHandler()
        }
    }
}
