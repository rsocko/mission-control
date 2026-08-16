import JavaScriptCore
import WebKit
import XCTest
@testable import MissionControl

@MainActor
final class WebBridgeScriptTests: XCTestCase {
    private var origin: TrustedOrigin!

    override func setUpWithError() throws {
        origin = try TrustedOrigin("https://mc.example.com")
    }

    func testExposesFrozenVersionedCapabilitiesOnlyAtTrustedMainFrame() throws {
        let context = try configuredContext(origin: "https://mc.example.com", isMainFrame: true)
        context.evaluateScript(WebBridgeScript.source(trustedOrigin: origin))

        XCTAssertTrue(context.evaluateScript("Object.isFrozen(window.mcNativeBridge)").toBool())
        XCTAssertTrue(
            context.evaluateScript("Object.isFrozen(window.mcNativeBridge.capabilities)").toBool()
        )
        XCTAssertEqual(
            context.evaluateScript("window.mcNativeBridge.contractVersion").toInt32(),
            1
        )
        XCTAssertEqual(
            context.evaluateScript("window.mcNativeBridge.supportedActions.length").toInt32(),
            Int32(NativeBridgeAction.allCases.count)
        )

        let external = try configuredContext(
            origin: "https://mc.example.com.evil.test",
            isMainFrame: true
        )
        external.evaluateScript(WebBridgeScript.source(trustedOrigin: origin))
        XCTAssertTrue(
            external.evaluateScript("typeof window.mcNativeBridge === 'undefined'").toBool()
        )

        let frame = try configuredContext(origin: "https://mc.example.com", isMainFrame: false)
        frame.evaluateScript(WebBridgeScript.source(trustedOrigin: origin))
        XCTAssertTrue(
            frame.evaluateScript("typeof window.mcNativeBridge === 'undefined'").toBool()
        )
    }

    func testDiscardsDuplicateLateAndUnsolicitedCallbacks() throws {
        let context = try configuredContext(origin: "https://mc.example.com", isMainFrame: true)
        context.evaluateScript(WebBridgeScript.source(trustedOrigin: origin))
        context.evaluateScript(
            """
            var responseCount = 0;
            window.mcNativeBridge.request("setBadge", { count: 3 }).then(() => {
              responseCount += 1;
            });
            """
        )
        XCTAssertEqual(context.evaluateScript("postedMessages.length").toInt32(), 1)

        context.evaluateScript(
            """
            var response = {
              version: 1,
              requestId: postedMessages[0].requestId,
              action: "setBadge",
              ok: true,
              result: { count: 3 }
            };
            window.__mcNativeBridgeReceive(response);
            window.__mcNativeBridgeReceive(response);
            window.__mcNativeBridgeReceive({
              ...response,
              requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            });
            """
        )
        context.evaluateScript("void 0")
        XCTAssertEqual(context.evaluateScript("responseCount").toInt32(), 1)
    }

    func testDeduplicatesEventsAndRemovalIsIdempotent() throws {
        let context = try configuredContext(origin: "https://mc.example.com", isMainFrame: true)
        context.evaluateScript(WebBridgeScript.source(trustedOrigin: origin))
        context.evaluateScript(
            """
            var eventCount = 0;
            var remove = window.mcNativeBridge.addEventListener(
              "networkStatus",
              () => { eventCount += 1; }
            );
            var event = {
              version: 1,
              requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              action: "networkStatus",
              payload: { status: "offline" }
            };
            window.__mcNativeBridgeReceive(event);
            window.__mcNativeBridgeReceive(event);
            remove();
            remove();
            window.__mcNativeBridgeReceive({
              ...event,
              requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
            });
            """
        )

        XCTAssertEqual(context.evaluateScript("eventCount").toInt32(), 1)
    }

    func testUserScriptIsMainFrameDocumentStartAndLifecycleIsIdempotent() throws {
        let script = WebBridgeScript.userScript(trustedOrigin: origin)
        XCTAssertTrue(script.isForMainFrameOnly)
        XCTAssertEqual(script.injectionTime, .atDocumentStart)

        let handler = RecordingActionHandler()
        let bridge = WebBridge(trustedOrigin: origin, actionHandler: handler)
        let configuration = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        bridge.attach(
            webView: webView,
            userContentController: configuration.userContentController
        )
        XCTAssertTrue(bridge.isHandlerInstalled)
        bridge.activate()
        XCTAssertTrue(bridge.isHandlerInstalled)
        bridge.deactivate()
        bridge.deactivate()
        XCTAssertFalse(bridge.isHandlerInstalled)
        bridge.activate()
        XCTAssertTrue(bridge.isHandlerInstalled)
        bridge.tearDown()
        XCTAssertFalse(bridge.isHandlerInstalled)
    }

    private func configuredContext(
        origin: String,
        isMainFrame: Bool
    ) throws -> JSContext {
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript(
            """
            var window = this;
            window.top = \(isMainFrame ? "window" : "{}");
            window.location = { origin: "\(origin)" };
            var postedMessages = [];
            window.webkit = {
              messageHandlers: {
                mcNativeBridgeHandler: {
                  postMessage: (message) => postedMessages.push(message)
                }
              }
            };
            var crypto = {
              next: 1,
              randomUUID: function() {
                var suffix = String(this.next++).padStart(12, "0");
                return "aaaaaaaa-aaaa-4aaa-8aaa-" + suffix;
              }
            };
            var TextEncoder = function() {
              this.encode = function(value) {
                return { byteLength: unescape(encodeURIComponent(value)).length };
              };
            };
            var timers = [];
            var setTimeout = function(callback) {
              timers.push(callback);
              return timers.length;
            };
            var clearTimeout = function() {};
            """
        )
        return context
    }
}

@MainActor
private final class RecordingActionHandler: NativeBridgeActionHandling {
    func handle(
        _ request: NativeBridgeRequest
    ) async -> Result<NativeBridgeResult, NativeBridgeError> {
        .failure(
            NativeBridgeError(
                code: .nativeFailure,
                message: "Not used by this test",
                retryable: false
            )
        )
    }
}
