import XCTest
@testable import CompanionCore

final class ProfileSaveGateTests: XCTestCase {
    @MainActor
    func testFailedSaveKeepsDraftAndDoesNotDismiss() async {
        var draft = "edited name"

        let shouldDismiss = await ProfileSaveGate.run(
            save: { Optional<String>.none },
            accept: { draft = $0 }
        )

        XCTAssertFalse(shouldDismiss)
        XCTAssertEqual(draft, "edited name")
    }

    @MainActor
    func testSuccessfulSaveAcceptsServerValueAndDismisses() async {
        var draft = "edited name"

        let shouldDismiss = await ProfileSaveGate.run(
            save: { "normalized name" },
            accept: { draft = $0 }
        )

        XCTAssertTrue(shouldDismiss)
        XCTAssertEqual(draft, "normalized name")
    }
}
