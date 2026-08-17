import XCTest
@testable import MissionControl

final class NavigationPolicyTests: XCTestCase {
    private var policy: NavigationPolicy!

    override func setUpWithError() throws {
        policy = NavigationPolicy(
            trustedOrigin: try TrustedOrigin("https://mc.example.com")
        )
    }

    func testAllowsEveryDeclaredTopLevelPathAndChildren() throws {
        XCTAssertEqual(
            policy.classifyTopLevel(
                try XCTUnwrap(URL(string: "https://mc.example.com"))
            ),
            .allowInWebView
        )

        for path in NavigationPolicy.allowedTopLevelPaths {
            let url = try XCTUnwrap(URL(string: "https://mc.example.com\(path)"))
            XCTAssertEqual(policy.classifyTopLevel(url), .allowInWebView, path)
        }

        XCTAssertEqual(
            policy.classifyTopLevel(
                try XCTUnwrap(URL(string: "https://mc.example.com/projects/roadmap?tab=active"))
            ),
            .allowInWebView
        )
    }

    func testBlocksUndeclaredSameOriginPathsAndPrefixLookalikes() throws {
        let blocked = [
            "/api",
            "/api/tasks",
            "/_next/static/app.js",
            "/mcp-widgets",
            "/admin",
            "/todayish",
            "/ai/../api",
            "/ai/%2e%2e/api",
            "/today/%00",
        ]

        for path in blocked {
            let url = try XCTUnwrap(URL(string: "https://mc.example.com\(path)"))
            XCTAssertEqual(policy.classifyTopLevel(url), .block, path)
        }
    }

    func testExternalizesOnlyHTTPAndHTTPSOtherOrigins() throws {
        let external = [
            "https://example.com/today",
            "https://mc.example.com.evil.test/today",
            "https://sub.mc.example.com/today",
            "https://mc.example.com:444/today",
            "http://mc.example.com/today",
        ]

        for value in external {
            XCTAssertEqual(
                policy.classifyTopLevel(try XCTUnwrap(URL(string: value))),
                .openExternally,
                value
            )
        }
    }

    func testBlocksUnsafeAndUnknownSchemes() throws {
        let blocked = [
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///etc/passwd",
            "blob:https://mc.example.com/id",
            "mailto:owner@example.com",
            "mc://view/today",
        ]

        for value in blocked {
            XCTAssertEqual(
                policy.classifyTopLevel(try XCTUnwrap(URL(string: value))),
                .block,
                value
            )
        }
    }
}
