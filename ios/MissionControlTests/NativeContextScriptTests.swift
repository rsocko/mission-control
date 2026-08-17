import JavaScriptCore
import WebKit
import XCTest
@testable import MissionControl

final class NativeContextScriptTests: XCTestCase {
    private var origin: TrustedOrigin!

    override func setUpWithError() throws {
        origin = try TrustedOrigin("https://mc.example.com")
    }

    func testExposesFrozenNonSecretContextOnExactTrustedOrigin() throws {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript(
            "var window = this; window.top = window; window.location = { origin: 'https://mc.example.com' };"
        )

        context.evaluateScript(NativeContextScript.source(trustedOrigin: origin))

        XCTAssertTrue(context.evaluateScript("window.isMCNativeApp === true").toBool())
        XCTAssertEqual(
            context.evaluateScript("window.MCNativeContext.platform").toString(),
            "ios"
        )
        XCTAssertEqual(
            context.evaluateScript("window.MCNativeContext.contractVersion").toInt32(),
            1
        )
        XCTAssertTrue(
            context.evaluateScript("Object.isFrozen(window.MCNativeContext)").toBool()
        )
        XCTAssertTrue(
            context.evaluateScript(
                "Object.keys(window.MCNativeContext).sort().join(',') === 'contractVersion,platform'"
            ).toBool()
        )
    }

    func testDoesNotExposeContextToOtherOriginsOrFrames() throws {
        let external = try XCTUnwrap(JSContext())
        external.evaluateScript(
            "var window = this; window.top = window; window.location = { origin: 'https://mc.example.com.evil.test' };"
        )
        external.evaluateScript(NativeContextScript.source(trustedOrigin: origin))
        XCTAssertTrue(
            external.evaluateScript("typeof window.isMCNativeApp === 'undefined'").toBool()
        )

        let frame = try XCTUnwrap(JSContext())
        frame.evaluateScript(
            "var window = this; window.top = {}; window.location = { origin: 'https://mc.example.com' };"
        )
        frame.evaluateScript(NativeContextScript.source(trustedOrigin: origin))
        XCTAssertTrue(
            frame.evaluateScript("typeof window.MCNativeContext === 'undefined'").toBool()
        )
    }

    func testWKUserScriptIsMainFrameOnlyAtDocumentStart() {
        let script = NativeContextScript.userScript(trustedOrigin: origin)

        XCTAssertTrue(script.isForMainFrameOnly)
        XCTAssertEqual(script.injectionTime, .atDocumentStart)
    }
}
