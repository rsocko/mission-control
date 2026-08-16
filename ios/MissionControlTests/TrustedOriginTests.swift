import XCTest
import WebKit
@testable import MissionControl

final class TrustedOriginTests: XCTestCase {
    func testNormalizesSchemeHostRootAndDefaultPort() throws {
        let origin = try TrustedOrigin("HTTPS://MC.Example.COM:443/")

        XCTAssertEqual(origin.serialized, "https://mc.example.com")
        XCTAssertEqual(origin.scheme, "https")
        XCTAssertEqual(origin.host, "mc.example.com")
        XCTAssertNil(origin.port)
    }

    func testPreservesNonDefaultPortAndRequiresItForExactMatch() throws {
        let origin = try TrustedOrigin("https://mc.example.com:8443")

        XCTAssertEqual(origin.serialized, "https://mc.example.com:8443")
        XCTAssertTrue(origin.matches(try XCTUnwrap(URL(string: "https://mc.example.com:8443/today"))))
        XCTAssertFalse(origin.matches(try XCTUnwrap(URL(string: "https://mc.example.com/today"))))
    }

    func testAllowsHTTPOnlyForLoopbackDevelopmentOrigins() throws {
        XCTAssertNoThrow(try TrustedOrigin("http://localhost:3098"))
        XCTAssertNoThrow(try TrustedOrigin("http://127.0.0.1:3098"))
        XCTAssertNoThrow(try TrustedOrigin("http://[::1]:3098"))
        XCTAssertThrowsError(try TrustedOrigin("http://mc.example.com"))
    }

    func testRejectsNonOriginAndAmbiguousValues() {
        let rejected = [
            "",
            " https://mc.example.com",
            "https://user@mc.example.com",
            "https://mc.example.com/today",
            "https://mc.example.com?next=/today",
            "https://mc.example.com#today",
            "https://mc.example.com.",
            "https://mc_example.com",
            "ftp://mc.example.com",
        ]

        for value in rejected {
            XCTAssertThrowsError(try TrustedOrigin(value), "Expected rejection for \(value)")
        }
    }

    func testRejectsLookalikesAndSubdomains() throws {
        let origin = try TrustedOrigin("https://mc.example.com")

        XCTAssertFalse(origin.matches(try XCTUnwrap(URL(string: "https://mc.example.com.evil.test/today"))))
        XCTAssertFalse(origin.matches(try XCTUnwrap(URL(string: "https://sub.mc.example.com/today"))))
        XCTAssertFalse(origin.matches(try XCTUnwrap(URL(string: "http://mc.example.com/today"))))
        XCTAssertFalse(origin.matches(try XCTUnwrap(URL(string: "https://mc.example.com:444/today"))))
    }

    @MainActor
    func testMediaCapturePermissionOnlyGrantsTrustedMainFrameMicrophone() throws {
        let trustedOrigin = try TrustedOrigin("https://mc.example.com")
        let trustedURL = try XCTUnwrap(URL(string: "https://mc.example.com"))
        let untrustedURL = try XCTUnwrap(URL(string: "https://evil.example"))

        XCTAssertTrue(WebViewController.shouldGrantMediaCapturePermission(
            origin: trustedURL,
            isMainFrame: true,
            type: .microphone,
            trustedOrigin: trustedOrigin
        ))
        XCTAssertFalse(WebViewController.shouldGrantMediaCapturePermission(
            origin: trustedURL,
            isMainFrame: false,
            type: .microphone,
            trustedOrigin: trustedOrigin
        ))
        XCTAssertFalse(WebViewController.shouldGrantMediaCapturePermission(
            origin: untrustedURL,
            isMainFrame: true,
            type: .microphone,
            trustedOrigin: trustedOrigin
        ))
        XCTAssertFalse(WebViewController.shouldGrantMediaCapturePermission(
            origin: trustedURL,
            isMainFrame: true,
            type: .camera,
            trustedOrigin: trustedOrigin
        ))
    }

    func testHostAppDeclaresVoiceCaptureUsageDescriptions() throws {
        let microphoneDescription = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String
        )
        let speechDescription = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") as? String
        )

        XCTAssertFalse(microphoneDescription.isEmpty)
        XCTAssertFalse(speechDescription.isEmpty)
    }
}
