import XCTest
@testable import CompanionCore

final class ChatListOrderTests: XCTestCase {
    func testNewestActivitySortsFirst() {
        let plumber = ChatListOrder.activity(createdAt: 1, taskActivities: [10_05], loadedMessageAt: 10_05)
        let monitor = ChatListOrder.activity(createdAt: 1, taskActivities: [8_01], loadedMessageAt: 8_01)
        let fixer = ChatListOrder.activity(createdAt: 1, taskActivities: [], loadedMessageAt: 1)

        XCTAssertTrue(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: plumber,
            pinnedRight: false, activityRight: monitor
        ))
        XCTAssertTrue(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: monitor,
            pinnedRight: false, activityRight: fixer
        ))
        XCTAssertFalse(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: fixer,
            pinnedRight: false, activityRight: plumber
        ))
    }

    func testUnreadDoesNotOutrankANewerChat() {
        // The old comparator put unread above recency. A read Plumber at
        // 10:05 must still sit above an unread Monitor at 8:01.
        let plumber = ChatListOrder.activity(createdAt: 1, taskActivities: [1005], loadedMessageAt: 1005)
        let monitor = ChatListOrder.activity(createdAt: 1, taskActivities: [801], loadedMessageAt: 801)
        XCTAssertTrue(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: plumber,
            pinnedRight: false, activityRight: monitor
        ))
    }

    func testPinnedWinsOverNewerUnpinnedActivity() {
        XCTAssertTrue(ChatListOrder.orderedBefore(
            pinnedLeft: true, activityLeft: 1,
            pinnedRight: false, activityRight: 99
        ))
        XCTAssertFalse(ChatListOrder.orderedBefore(
            pinnedLeft: false, activityLeft: 99,
            pinnedRight: true, activityRight: 1
        ))
    }

    func testTaskLastActivityBeatsTheOpenThreadWhenItIsNewer() {
        let stamp = ChatListOrder.activity(
            createdAt: 1,
            taskActivities: [10, 90],
            loadedMessageAt: 15
        )
        XCTAssertEqual(stamp, 90)
    }

    func testFallsBackToCreatedAtWhenNothingHasLanded() {
        XCTAssertEqual(
            ChatListOrder.activity(createdAt: 42, taskActivities: [], loadedMessageAt: nil),
            42
        )
    }
}
