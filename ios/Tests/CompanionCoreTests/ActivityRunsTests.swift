import XCTest
@testable import CompanionCore

final class ActivityRunsTests: XCTestCase {
    private func makeToolMessage(id: String, name: String, ok: Bool? = true, role: Message.Role = .bot) -> Message {
        Message(
            id: id,
            role: role,
            kind: .activity,
            at: 1000,
            tool: ToolActivity(name: name, ok: ok)
        )
    }

    private func makeTextMessage(id: String, text: String, role: Message.Role = .bot) -> Message {
        Message(
            id: id,
            role: role,
            kind: .text,
            at: 1000,
            text: text
        )
    }

    func testSingleToolIsNotFolded() {
        let messages = [makeToolMessage(id: "1", name: "view_file")]
        let items = groupActivityRuns(messages)
        XCTAssertEqual(items.count, 1)
        if case let .message(msg) = items[0] {
            XCTAssertEqual(msg.id, "1")
        } else {
            XCTFail("Expected single message")
        }
    }

    func testConsecutiveToolsAreFoldedIntoRun() {
        let messages = [
            makeToolMessage(id: "1", name: "view_file"),
            makeToolMessage(id: "2", name: "run_command"),
            makeToolMessage(id: "3", name: "run_command"),
            makeTextMessage(id: "4", text: "Done!"),
        ]
        let items = groupActivityRuns(messages)
        XCTAssertEqual(items.count, 2)
        if case let .run(id, runMsgs) = items[0] {
            XCTAssertEqual(id, "run:1")
            XCTAssertEqual(runMsgs.count, 3)
            let desc = describeActivityRun(runMsgs)
            XCTAssertEqual(desc.headline, "3 tool calls")
            XCTAssertTrue(desc.summary.contains("run_command ×2"))
        } else {
            XCTFail("Expected run")
        }
        if case let .message(msg) = items[1] {
            XCTAssertEqual(msg.id, "4")
        } else {
            XCTFail("Expected text message")
        }
    }

    func testTextMessagesBreakRuns() {
        let messages = [
            makeToolMessage(id: "1", name: "view_file"),
            makeToolMessage(id: "2", name: "run_command"),
            makeTextMessage(id: "3", text: "Intermediate thought"),
            makeToolMessage(id: "4", name: "run_command"),
            makeToolMessage(id: "5", name: "run_command"),
        ]
        let items = groupActivityRuns(messages)
        XCTAssertEqual(items.count, 3)
        if case let .run(_, run1) = items[0] {
            XCTAssertEqual(run1.count, 2)
        } else {
            XCTFail("Expected first run")
        }
        if case let .message(msg) = items[1] {
            XCTAssertEqual(msg.id, "3")
        } else {
            XCTFail("Expected text message")
        }
        if case let .run(_, run2) = items[2] {
            XCTAssertEqual(run2.count, 2)
        } else {
            XCTFail("Expected second run")
        }
    }
}
