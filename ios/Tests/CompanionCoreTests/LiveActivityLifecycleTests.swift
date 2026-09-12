import XCTest
@testable import CompanionCore

final class LiveActivityLifecycleTests: XCTestCase {
    func testBackgroundEndsActivitiesAndRejectsOldForegroundWork() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertFalse(lifecycle.updatesEnabled)

        XCTAssertEqual(lifecycle.transition(to: .active), .sync)
        let foregroundGeneration = lifecycle.generation
        XCTAssertTrue(lifecycle.permitsUpdates(from: foregroundGeneration))

        XCTAssertNil(lifecycle.transition(to: .inactive))
        XCTAssertTrue(lifecycle.permitsUpdates(from: foregroundGeneration))

        XCTAssertEqual(lifecycle.transition(to: .background), .endAll)
        XCTAssertFalse(lifecycle.permitsUpdates(from: foregroundGeneration))
        XCTAssertNil(lifecycle.transition(to: .background), "repeat notifications must not enqueue duplicate teardown")
    }

    func testForegroundReturnCreatesANewGenerationAndResyncs() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertEqual(lifecycle.transition(to: .background), .endAll)
        let backgroundGeneration = lifecycle.generation

        XCTAssertNil(lifecycle.transition(to: .inactive))
        XCTAssertEqual(lifecycle.transition(to: .active), .sync)
        XCTAssertGreaterThan(lifecycle.generation, backgroundGeneration)
        XCTAssertTrue(lifecycle.permitsUpdates(from: lifecycle.generation))
        XCTAssertFalse(lifecycle.permitsUpdates(from: backgroundGeneration))
    }
}
