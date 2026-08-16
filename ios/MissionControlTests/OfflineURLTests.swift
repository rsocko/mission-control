import XCTest
@testable import MissionControl

@MainActor
final class OfflineURLTests: XCTestCase {
    func testOfflineFallbackUsesExactConfiguredOrigin() throws {
        let standardOrigin = try TrustedOrigin("https://mc.example.com")
        let customPortOrigin = try TrustedOrigin("https://mc.example.com:8443")

        XCTAssertEqual(
            WebViewController.offlineURL(for: standardOrigin).absoluteString,
            "https://mc.example.com/~offline"
        )
        XCTAssertEqual(
            WebViewController.offlineURL(for: customPortOrigin).absoluteString,
            "https://mc.example.com:8443/~offline"
        )
    }

    func testReloadsTrustedRecoveryURLOnlyAfterReconnect() {
        XCTAssertFalse(
            WebViewController.shouldReloadAfterNetworkTransition(from: nil, to: .online)
        )
        XCTAssertFalse(
            WebViewController.shouldReloadAfterNetworkTransition(from: .online, to: .online)
        )
        XCTAssertFalse(
            WebViewController.shouldReloadAfterNetworkTransition(from: .online, to: .offline)
        )
        XCTAssertTrue(
            WebViewController.shouldReloadAfterNetworkTransition(from: .offline, to: .online)
        )
    }

    func testReconnectPrefersCurrentValidatedClientSideRoute() throws {
        let origin = try TrustedOrigin("https://mc.example.com")
        let policy = NavigationPolicy(trustedOrigin: origin)
        let recoveryURL = try XCTUnwrap(URL(string: "https://mc.example.com/today"))
        let clientSideURL = try XCTUnwrap(
            URL(string: "https://mc.example.com/projects/roadmap?tab=tasks")
        )

        XCTAssertEqual(
            WebViewController.reconnectURL(
                currentURL: clientSideURL,
                recoveryURL: recoveryURL,
                navigationPolicy: policy
            ),
            clientSideURL
        )
        XCTAssertEqual(
            WebViewController.reconnectURL(
                currentURL: try XCTUnwrap(URL(string: "https://evil.example/today")),
                recoveryURL: recoveryURL,
                navigationPolicy: policy
            ),
            recoveryURL
        )
        XCTAssertEqual(
            WebViewController.reconnectURL(
                currentURL: try XCTUnwrap(URL(string: "https://mc.example.com/~offline")),
                recoveryURL: recoveryURL,
                navigationPolicy: policy
            ),
            recoveryURL
        )
    }
}
