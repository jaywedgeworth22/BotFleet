import XCTest
@testable import CompanionCore

final class LiveActivityLifecycleTests: XCTestCase {
    func testBackgroundEndsActivitiesAndRejectsOldForegroundWork() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertFalse(lifecycle.updatesEnabled)

        XCTAssertEqual(lifecycle.transition(to: .active), .resetAndAwaitFreshState)
        let foregroundGeneration = lifecycle.generation
        XCTAssertFalse(lifecycle.permitsUpdates(from: foregroundGeneration))
        XCTAssertTrue(lifecycle.acceptFreshState(for: foregroundGeneration))
        XCTAssertTrue(lifecycle.permitsUpdates(from: foregroundGeneration))

        XCTAssertNil(lifecycle.transition(to: .inactive))
        XCTAssertTrue(lifecycle.permitsUpdates(from: foregroundGeneration))

        XCTAssertEqual(lifecycle.transition(to: .background), .endAll)
        XCTAssertFalse(lifecycle.permitsUpdates(from: foregroundGeneration))
        XCTAssertFalse(lifecycle.acceptFreshState(for: foregroundGeneration))
        XCTAssertNil(lifecycle.transition(to: .background), "repeat notifications must not enqueue duplicate teardown")
    }

    func testForegroundReturnAcceptsOnlyItsOwnFreshSnapshot() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertEqual(lifecycle.transition(to: .active), .resetAndAwaitFreshState)
        let staleResumeGeneration = lifecycle.generation
        XCTAssertEqual(lifecycle.transition(to: .background), .endAll)

        XCTAssertNil(lifecycle.transition(to: .inactive))
        XCTAssertEqual(lifecycle.transition(to: .active), .awaitFreshState)
        let currentResumeGeneration = lifecycle.generation
        XCTAssertFalse(lifecycle.permitsUpdates(from: lifecycle.generation))
        XCTAssertFalse(lifecycle.acceptFreshState(for: staleResumeGeneration))
        XCTAssertTrue(lifecycle.acceptFreshState(for: currentResumeGeneration))
        XCTAssertTrue(lifecycle.permitsUpdates(from: currentResumeGeneration))
        XCTAssertFalse(lifecycle.permitsUpdates(from: staleResumeGeneration))
    }

    func testInactiveOnlyInterruptionRetainsCurrentUpdatePolicy() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertEqual(lifecycle.transition(to: .active), .resetAndAwaitFreshState)
        let foregroundGeneration = lifecycle.generation

        XCTAssertNil(lifecycle.transition(to: .inactive))
        XCTAssertTrue(lifecycle.acceptFreshState(for: foregroundGeneration))
        XCTAssertNil(lifecycle.transition(to: .active))
        XCTAssertEqual(lifecycle.generation, foregroundGeneration)
        XCTAssertTrue(lifecycle.permitsUpdates(from: foregroundGeneration))
    }

    func testForegroundRepairingResetsActivitiesAndRestartsFreshHydration() {
        var lifecycle = LiveActivityLifecycle()
        XCTAssertEqual(lifecycle.transition(to: .active), .resetAndAwaitFreshState)
        let oldPairingGeneration = lifecycle.generation
        XCTAssertTrue(lifecycle.acceptFreshState(for: oldPairingGeneration))

        XCTAssertEqual(lifecycle.pairingChanged(isPaired: false), .endAll)
        XCTAssertFalse(lifecycle.permitsUpdates(from: oldPairingGeneration))
        XCTAssertEqual(lifecycle.pairingChanged(isPaired: true), .resetAndAwaitFreshState)
        let newPairingGeneration = lifecycle.generation
        XCTAssertFalse(lifecycle.acceptFreshState(for: oldPairingGeneration))
        XCTAssertTrue(lifecycle.acceptFreshState(for: newPairingGeneration))
        XCTAssertTrue(lifecycle.permitsUpdates(from: newPairingGeneration))
    }

    func testSnapshotRevisionConflictsUseBoundedExponentialBackoff() {
        var backoff = LiveActivityRefreshBackoff(
            initialNanoseconds: 1,
            maximumNanoseconds: 15
        )

        XCTAssertEqual(
            (0..<7).map { _ in backoff.takeNextDelay() },
            [1, 2, 4, 8, 15, 15, 15]
        )
    }
}
