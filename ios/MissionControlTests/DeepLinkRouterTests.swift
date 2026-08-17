import XCTest
@testable import MissionControl

final class DeepLinkRouterTests: XCTestCase {
    private var router: DeepLinkRouter!

    override func setUpWithError() throws {
        router = DeepLinkRouter(
            trustedOrigin: try TrustedOrigin("https://mc.example.com")
        )
    }

    func testMapsDeclaredCustomDeepLinks() throws {
        let mappings = [
            "mc://view/today": "https://mc.example.com/today",
            "mc://view/triage": "https://mc.example.com/triage",
            "mc://view/capture": "https://mc.example.com/capture",
            "mc://capture": "https://mc.example.com/capture",
            "mc://view/quick-sort": "https://mc.example.com/quick-sort",
            "mc://view/houston": "https://mc.example.com/ai",
        ]

        for (input, expected) in mappings {
            XCTAssertEqual(
                router.destination(for: try XCTUnwrap(URL(string: input)))?.absoluteString,
                expected,
                input
            )
        }
    }

    func testPreservesQueryAsUntrustedPageInput() throws {
        let destination = router.destination(
            for: try XCTUnwrap(URL(string: "mc://view/today?filter=mine%20only"))
        )

        XCTAssertEqual(
            destination?.absoluteString,
            "https://mc.example.com/today?filter=mine%20only"
        )
    }

    func testRejectsUnknownOrMalformedCustomDeepLinks() throws {
        let rejected = [
            "mc://view/projects",
            "mc://view/today/child",
            "mc://view/today#fragment",
            "mc://user@view/today",
            "mc://view:443/today",
            "mc://auth/callback",
            "other://view/today",
        ]

        for value in rejected {
            XCTAssertNil(
                router.destination(for: try XCTUnwrap(URL(string: value))),
                value
            )
        }
    }

    func testAcceptsOnlyExactOriginAllowlistedUniversalLinks() throws {
        XCTAssertEqual(
            router.destination(
                for: try XCTUnwrap(URL(string: "https://mc.example.com/projects/one?tab=tasks"))
            )?.absoluteString,
            "https://mc.example.com/projects/one?tab=tasks"
        )
        XCTAssertNil(
            router.destination(
                for: try XCTUnwrap(URL(string: "https://mc.example.com/api/tasks"))
            )
        )
        XCTAssertNil(
            router.destination(
                for: try XCTUnwrap(URL(string: "https://mc.example.com.evil.test/today"))
            )
        )
        XCTAssertNil(
            router.destination(
                for: try XCTUnwrap(URL(string: "https://sub.mc.example.com/today"))
            )
        )
    }
}
