import XCTest
@testable import CompanionCore

final class ProfileSaveGateTests: XCTestCase {
    @MainActor
    func testFailedSaveKeepsDraftForSuccessfulRetry() async {
        var draft = "edited name"
        var attempts = 0

        let failedSaveShouldDismiss = await ProfileSaveGate.run(
            save: {
                attempts += 1
                return Optional<String>.none
            },
            accept: { draft = $0 }
        )

        XCTAssertFalse(failedSaveShouldDismiss)
        XCTAssertEqual(draft, "edited name")

        let retryShouldDismiss = await ProfileSaveGate.run(
            save: {
                attempts += 1
                return "normalized name"
            },
            accept: { draft = $0 }
        )

        XCTAssertTrue(retryShouldDismiss)
        XCTAssertEqual(draft, "normalized name")
        XCTAssertEqual(attempts, 2)
    }
}
