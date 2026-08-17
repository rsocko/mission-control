import XCTest
@testable import MissionControl

@MainActor
final class NativeBridgeContractTests: XCTestCase {
    private var trustedOrigin: TrustedOrigin!
    private let requestId = "8cf177a0-e46a-46fa-824c-4c34004e2423"

    override func setUpWithError() throws {
        trustedOrigin = try TrustedOrigin("https://mc.example.com")
    }

    func testSharedFixturesDecodeAsClosedSwiftV1Types() throws {
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("contracts/fixtures/mobile-ios-native-v1.json")
        let data = try Data(contentsOf: fixtureURL)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let requests = try XCTUnwrap(root["requests"] as? [Any])
        let responses = try XCTUnwrap(root["responses"] as? [Any])
        let events = try XCTUnwrap(root["events"] as? [Any])

        XCTAssertEqual(
            try requests.map(NativeBridgeCodec.decodeRequest(from:)).map(\.action),
            NativeBridgeAction.allCases
        )
        XCTAssertEqual(
            try responses.map(NativeBridgeCodec.decodeResponse(from:)).count,
            2
        )
        XCTAssertEqual(
            try events.map(NativeBridgeCodec.decodeEvent(from:)).count,
            NativeBridgeEventAction.allCases.count
        )
    }

    func testRejectsUnknownVersionActionFieldsAndMalformedPayloads() throws {
        assertFailure(
            body: request(
                version: 2,
                action: "setBadge",
                payload: ["count": 1]
            ),
            equals: .unsupportedVersion(2)
        )
        assertFailure(
            body: request(action: "readKeychain", payload: [:]),
            equals: .unsupportedAction("readKeychain")
        )
        var extended = request(action: "setBadge", payload: ["count": 1])
        extended["accessToken"] = "must-not-cross-the-bridge"
        assertFailure(body: extended, equals: .invalidMessage)
        assertFailure(
            body: request(
                action: "hapticFeedback",
                payload: ["type": "impact", "intensity": 1.1]
            ),
            equals: .invalidMessage
        )
        assertFailure(
            body: request(action: "setBadge", payload: ["count": 1_000]),
            equals: .invalidMessage
        )
        var invalidUUID = request(action: "setBadge", payload: ["count": 1])
        invalidUUID["requestId"] = "00000000-0000-0000-0000-000000000000"
        assertFailure(body: invalidUUID, equals: .invalidMessage)
    }

    func testRejectsCredentialBearingAndUnsafeOpenURLsThroughNavigationPolicy() throws {
        let rejected = [
            "https://user:password@mc.example.com/today",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://[::1]/today",
            "https://999.999.999.999/today",
        ]
        for url in rejected {
            assertFailure(
                body: request(action: "openURL", payload: ["url": url]),
                equals: .invalidMessage
            )
        }

        XCTAssertNoThrow(
            try NativeBridgeCodec.decodeRequest(
                from: request(
                    action: "openURL",
                    payload: ["url": "https://example.com/article"]
                )
            )
        )
    }

    func testEnforcesEnvelopeSizeBeforeDecoding() throws {
        let oversized = request(
            action: "bootstrap",
            payload: ["webClientVersion": String(repeating: "x", count: 70_000)]
        )
        assertFailure(body: oversized, equals: .messageTooLarge)
        XCTAssertLessThanOrEqual(
            try JSONSerialization.data(
                withJSONObject: request(
                    action: "bootstrap",
                    payload: ["webClientVersion": "1.0.0"]
                )
            ).count,
            NativeBridgeCodec.maximumMessageBytes
        )
    }

    func testUsesUnicodeCodePointBoundsAndClosedErrorEnvelopes() throws {
        let valid = successResponse(appVersion: String(repeating: "😀", count: 64))
        XCTAssertNoThrow(try NativeBridgeCodec.decodeResponse(from: valid))
        XCTAssertThrowsError(
            try NativeBridgeCodec.decodeResponse(
                from: successResponse(appVersion: String(repeating: "😀", count: 65))
            )
        )

        var error = errorResponse()
        var detailsError = try XCTUnwrap(error["error"] as? [String: Any])
        detailsError["details"] = ["accessToken": "must-not-cross-the-bridge"]
        error["error"] = detailsError
        XCTAssertThrowsError(try NativeBridgeCodec.decodeResponse(from: error))
    }

    func testPushEventRequiresOnlyRegisteredStateToCarryRegistrationId() throws {
        let registered = event(
            action: "pushRegistrationChanged",
            payload: [
                "authorization": "authorized",
                "state": "registered",
                "registrationId": "c83d74ec-d4a1-45f7-8153-79fdb63cafb9",
            ]
        )
        XCTAssertNoThrow(try NativeBridgeCodec.decodeEvent(from: registered))

        var missing = registered
        missing["payload"] = [
            "authorization": "authorized",
            "state": "registered",
        ]
        XCTAssertThrowsError(try NativeBridgeCodec.decodeEvent(from: missing))

        var token = registered
        token["payload"] = [
            "authorization": "authorized",
            "state": "registered",
            "registrationId": "c83d74ec-d4a1-45f7-8153-79fdb63cafb9",
            "deviceToken": "must-not-cross-the-bridge",
        ]
        XCTAssertThrowsError(try NativeBridgeCodec.decodeEvent(from: token))
    }

    func testValidatorReturnsExplicitOriginVersionActionAndMalformedErrors() throws {
        let trusted = NativeBridgeMessageOrigin(
            scheme: "https",
            host: "mc.example.com",
            port: nil
        )
        let untrusted = NativeBridgeMessageOrigin(
            scheme: "https",
            host: "mc.example.com.evil.test",
            port: nil
        )
        let valid = request(action: "setBadge", payload: ["count": 1])

        assertValidationError(
            NativeBridgeMessageValidator.validate(
                body: valid,
                isMainFrame: false,
                origin: trusted,
                trustedOrigin: trustedOrigin
            ),
            code: .untrustedOrigin
        )
        assertValidationError(
            NativeBridgeMessageValidator.validate(
                body: valid,
                isMainFrame: true,
                origin: untrusted,
                trustedOrigin: trustedOrigin
            ),
            code: .untrustedOrigin
        )
        assertValidationError(
            NativeBridgeMessageValidator.validate(
                body: request(
                    version: 9,
                    action: "setBadge",
                    payload: ["count": 1]
                ),
                isMainFrame: true,
                origin: trusted,
                trustedOrigin: trustedOrigin
            ),
            code: .unsupportedVersion
        )
        assertValidationError(
            NativeBridgeMessageValidator.validate(
                body: request(action: "readKeychain", payload: [:]),
                isMainFrame: true,
                origin: trusted,
                trustedOrigin: trustedOrigin
            ),
            code: .unsupportedAction
        )
        assertValidationError(
            NativeBridgeMessageValidator.validate(
                body: request(action: "setBadge", payload: ["count": -1]),
                isMainFrame: true,
                origin: trusted,
                trustedOrigin: trustedOrigin
            ),
            code: .invalidMessage
        )
    }

    func testMapsVersionOneHapticPayloadsToSemanticNativePatterns() {
        XCTAssertEqual(
            NativeHapticPattern.resolve(
                HapticFeedbackPayload(type: .success, intensity: nil)
            ),
            .success
        )
        XCTAssertEqual(
            NativeHapticPattern.resolve(
                HapticFeedbackPayload(type: .success, intensity: 1)
            ),
            .celebration
        )
        XCTAssertEqual(
            NativeHapticPattern.resolve(
                HapticFeedbackPayload(type: .impact, intensity: 0.35)
            ),
            .lightImpact(0.35)
        )
        XCTAssertEqual(
            NativeHapticPattern.resolve(
                HapticFeedbackPayload(type: .impact, intensity: 0.75)
            ),
            .mediumImpact(0.75)
        )
        XCTAssertEqual(
            NativeHapticPattern.resolve(
                HapticFeedbackPayload(type: .selection, intensity: 0.3)
            ),
            .softTick(0.3)
        )
        XCTAssertEqual(
            NativeHapticPattern.resolve(
                HapticFeedbackPayload(type: .warning, intensity: nil)
            ),
            .warning
        )
    }

    func testHapticProviderRespectsReducedMotionAndReportsDriverFailure() {
        let reducedMotionDriver = RecordingHapticDriver(delivered: true)
        let reducedMotionProvider = AccessibleHapticFeedbackProvider(
            driver: reducedMotionDriver,
            isReduceMotionEnabled: { true }
        )
        XCTAssertFalse(
            reducedMotionProvider.deliver(
                HapticFeedbackPayload(type: .success, intensity: nil)
            )
        )
        XCTAssertTrue(reducedMotionDriver.patterns.isEmpty)

        let unavailableDriver = RecordingHapticDriver(delivered: false)
        let unavailableProvider = AccessibleHapticFeedbackProvider(
            driver: unavailableDriver,
            isReduceMotionEnabled: { false }
        )
        XCTAssertFalse(
            unavailableProvider.deliver(
                HapticFeedbackPayload(type: .impact, intensity: 0.35)
            )
        )
        XCTAssertEqual(unavailableDriver.patterns, [.lightImpact(0.35)])
    }

    func testActionHandlerReturnsDeliveryStateAndStopsHapticResources() async {
        let driver = RecordingHapticDriver(delivered: false)
        let provider = AccessibleHapticFeedbackProvider(
            driver: driver,
            isReduceMotionEnabled: { false }
        )
        var handler: SystemNativeBridgeActionHandler? = SystemNativeBridgeActionHandler(
            hapticFeedbackProvider: provider
        )
        let request = NativeBridgeRequest(
            requestId: UUID(),
            payload: .hapticFeedback(
                HapticFeedbackPayload(type: .warning, intensity: nil)
            )
        )

        let result = await handler?.handle(request)

        XCTAssertEqual(
            result,
            .success(.hapticFeedback(HapticFeedbackResult(delivered: false)))
        )
        XCTAssertEqual(driver.patterns, [.warning])
        handler?.tearDown()
        XCTAssertTrue(driver.didStop)
        handler = nil
    }

    private func request(
        version: Int = 1,
        action: String,
        payload: [String: Any]
    ) -> [String: Any] {
        [
            "version": version,
            "requestId": requestId,
            "action": action,
            "payload": payload,
        ]
    }

    @MainActor
    private final class RecordingHapticDriver: NativeHapticDriving {
        private let delivered: Bool
        private(set) var patterns: [NativeHapticPattern] = []
        private(set) var didStop = false

        init(delivered: Bool) {
            self.delivered = delivered
        }

        func deliver(_ pattern: NativeHapticPattern) -> Bool {
            patterns.append(pattern)
            return delivered
        }

        func stop() {
            didStop = true
        }
    }

    private func successResponse(appVersion: String) -> [String: Any] {
        [
            "version": 1,
            "requestId": requestId,
            "action": "bootstrap",
            "ok": true,
            "result": [
                "appVersion": appVersion,
                "buildNumber": 42,
                "authentication": "unauthenticated",
                "capabilities": NativeBridgeCapability.allCases.map(\.rawValue),
            ],
        ]
    }

    private func errorResponse() -> [String: Any] {
        [
            "version": 1,
            "requestId": requestId,
            "action": "setBadge",
            "ok": false,
            "error": [
                "code": "NATIVE_FAILURE",
                "message": "The badge could not be set",
                "retryable": true,
            ] as [String: Any],
        ]
    }

    private func event(action: String, payload: [String: Any]) -> [String: Any] {
        [
            "version": 1,
            "requestId": requestId,
            "action": action,
            "payload": payload,
        ]
    }

    private func assertFailure(
        body: Any,
        equals expected: NativeBridgeDecodingError,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(
            try NativeBridgeCodec.decodeRequest(from: body),
            file: file,
            line: line
        ) { error in
            XCTAssertEqual(
                error as? NativeBridgeDecodingError,
                expected,
                file: file,
                line: line
            )
        }
    }

    private func assertValidationError(
        _ validation: NativeBridgeMessageValidation,
        code: NativeBridgeErrorCode,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard case let .rejection(response?) = validation,
              case let .failure(_, _, error) = response
        else {
            return XCTFail("Expected a structured rejection", file: file, line: line)
        }
        XCTAssertEqual(error.code, code, file: file, line: line)
    }
}
