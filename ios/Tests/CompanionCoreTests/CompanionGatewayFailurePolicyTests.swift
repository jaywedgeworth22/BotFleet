import XCTest
@testable import CompanionCore

final class CompanionGatewayFailurePolicyTests: XCTestCase {
    private var paired: Connection!

    override func setUpWithError() throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        paired = Connection(
            name: "Mac",
            host: "mac.companion.example",
            port: 443,
            activeEndpoint: hosted,
            endpoints: [hosted],
            allowedRouteKinds: [.hosted]
        )
    }

    func testSuppressesExpectedOfflineStatusesFromPairedGateway() {
        for statusCode in [502, 503, 530] {
            XCTAssertTrue(
                CompanionGatewayFailurePolicy.shouldSuppress(
                    statusCode: statusCode,
                    requestURL: "https://mac.companion.example/api/health",
                    pairedConnection: paired
                ),
                "Expected status \(statusCode) from the paired gateway to be suppressed"
            )
        }
    }

    func testPreservesExpectedStatusesFromOtherHosts() {
        XCTAssertFalse(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 503,
                requestURL: "https://status.example/api/health",
                pairedConnection: paired
            )
        )
    }

    func testRecognizesAnAuthorizedFallbackRouteForThePairedGateway() throws {
        let hosted = try XCTUnwrap(CompanionEndpoint(
            url: "https://mac.companion.example",
            kind: .hosted,
            priority: 0
        ))
        let tailnet = try XCTUnwrap(CompanionEndpoint(
            url: "http://mac.tail1234.ts.net:8810",
            kind: .tailnet,
            priority: 1
        ))
        let pairedWithFallback = Connection(
            name: "Mac",
            host: "mac.companion.example",
            port: 443,
            activeEndpoint: hosted,
            endpoints: [hosted, tailnet],
            allowedRouteKinds: [.hosted, .tailnet]
        )

        XCTAssertTrue(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 530,
                requestURL: "http://mac.tail1234.ts.net:8810/api/health",
                pairedConnection: pairedWithFallback
            )
        )
    }

    func testPreservesUnexpectedStatusesFromPairedGateway() {
        for statusCode in [500, 501, 504, 599] {
            XCTAssertFalse(
                CompanionGatewayFailurePolicy.shouldSuppress(
                    statusCode: statusCode,
                    requestURL: "https://mac.companion.example/api/health",
                    pairedConnection: paired
                ),
                "Unexpected status \(statusCode) from the paired gateway must remain reportable"
            )
        }
    }

    func testRequiresAnExactPairedOriginIncludingPortAndScheme() {
        for requestURL in [
            "https://mac.companion.example:8443/api/health",
            "http://mac.companion.example/api/health",
            "https://sub.mac.companion.example/api/health"
        ] {
            XCTAssertFalse(
                CompanionGatewayFailurePolicy.shouldSuppress(
                    statusCode: 502,
                    requestURL: requestURL,
                    pairedConnection: paired
                ),
                "Unpaired origin \(requestURL) must remain reportable"
            )
        }
    }

    func testMissingConnectionOrMalformedURLDoesNotSuppress() {
        XCTAssertFalse(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 530,
                requestURL: "https://mac.companion.example/api/health",
                pairedConnection: nil
            )
        )
        XCTAssertFalse(
            CompanionGatewayFailurePolicy.shouldSuppress(
                statusCode: 530,
                requestURL: "not a url",
                pairedConnection: paired
            )
        )
    }
}
