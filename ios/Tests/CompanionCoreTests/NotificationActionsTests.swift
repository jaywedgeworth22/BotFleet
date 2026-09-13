// Category registration and action routing, tested as pure data — no
// `UNUserNotificationCenter` and no simulator, per NotificationActions.swift.
import UserNotifications
import XCTest
@testable import CompanionCore

final class NotificationActionsTests: XCTestCase {
    // MARK: - Category registration

    func testRegisteredCategoriesMatchTheApprovalAndUpdateIdentifiers() {
        let categories = NotificationCategories.all()
        XCTAssertEqual(
            Set(categories.map(\.identifier)),
            [NotificationCategoryIdentifier.approval, NotificationCategoryIdentifier.update]
        )
    }

    func testApprovalCategoryHasApproveDenyAndOpenWithTitleCaseTitles() throws {
        let approval = try XCTUnwrap(
            NotificationCategories.all().first { $0.identifier == NotificationCategoryIdentifier.approval }
        )
        XCTAssertEqual(
            approval.actions.map(\.identifier),
            [NotificationActionIdentifier.approve, NotificationActionIdentifier.deny, NotificationActionIdentifier.open]
        )
        XCTAssertEqual(approval.actions.map(\.title), ["Approve", "Deny", "Open"])

        let approve = try XCTUnwrap(approval.actions.first { $0.identifier == NotificationActionIdentifier.approve })
        XCTAssertTrue(approve.options.contains(.authenticationRequired))
        XCTAssertFalse(approve.options.contains(.destructive))

        let deny = try XCTUnwrap(approval.actions.first { $0.identifier == NotificationActionIdentifier.deny })
        XCTAssertTrue(deny.options.contains(.destructive))

        let open = try XCTUnwrap(approval.actions.first { $0.identifier == NotificationActionIdentifier.open })
        XCTAssertTrue(open.options.contains(.foreground))
    }

    func testUpdateCategoryHasOnlyOpen() throws {
        let update = try XCTUnwrap(
            NotificationCategories.all().first { $0.identifier == NotificationCategoryIdentifier.update }
        )
        XCTAssertEqual(update.actions.map(\.identifier), [NotificationActionIdentifier.open])
        XCTAssertEqual(update.actions.map(\.title), ["Open"])
    }

    // MARK: - Action routing

    private let payload: [AnyHashable: Any] = ["threadId": "task-2", "botId": "bot-1", "kind": "approval"]

    func testApproveActionRoutesToApprove() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.approve, userInfo: payload),
            .approve(NotificationTarget(botId: "bot-1", threadId: "task-2")!)
        )
    }

    func testDenyActionRoutesToDeny() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.deny, userInfo: payload),
            .deny(NotificationTarget(botId: "bot-1", threadId: "task-2")!)
        )
    }

    func testOpenActionAndDefaultTapBothRouteToOpen() {
        let expected = NotificationActionRoute.open(NotificationTarget(botId: "bot-1", threadId: "task-2")!)
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.open, userInfo: payload),
            expected
        )
        XCTAssertEqual(
            NotificationTarget.actionRoute(
                actionIdentifier: UNNotificationDefaultActionIdentifier,
                userInfo: payload
            ),
            expected
        )
    }

    func testDismissActionIsANoOp() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: UNNotificationDismissActionIdentifier, userInfo: payload),
            .dismiss
        )
    }

    func testUnknownActionIsIgnored() {
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: "SOME_OTHER_ACTION", userInfo: payload),
            .ignore
        )
    }

    func testApproveOrDenyWithoutUsableIdsIsIgnored() {
        let malformed: [AnyHashable: Any] = ["botId": "bot-1"] // no threadId
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.approve, userInfo: malformed),
            .ignore
        )
        XCTAssertEqual(
            NotificationTarget.actionRoute(actionIdentifier: NotificationActionIdentifier.deny, userInfo: malformed),
            .ignore
        )
    }

    // MARK: - The literal choices sent through the shared answer path

    /// `Session.answerPendingRequest` sends "Approve"/"Deny" through
    /// `OptionCard.responseBehavior`, the same card logic every other
    /// surface uses.  Pin those two literals to the behavior they must
    /// produce so a rename anywhere silently breaking approval is a test
    /// failure, not a support ticket.
    func testApproveAndDenyLiteralsMapToTheirCardBehavior() {
        XCTAssertEqual(OptionCard.responseBehavior(for: "Approve", isPermission: true), "allow")
        XCTAssertEqual(OptionCard.responseBehavior(for: "Deny", isPermission: true), "deny")
    }
}
