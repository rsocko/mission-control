import UniformTypeIdentifiers
import XCTest
@testable import MissionControl

@MainActor
final class ShareCaptureCoreTests: XCTestCase {
    func testExtractsURLBeforeTextAndRejectsImage() async throws {
        let items: [String: NSSecureCoding] = [
            UTType.url.identifier: try XCTUnwrap(
                NSURL(string: "https://example.com/article")
            ),
            UTType.plainText.identifier: "selected text" as NSString,
        ]
        let provider = MockShareProvider(items: items)
        let content: ShareCaptureContent = try await ShareItemExtractor.extract(from: [provider])
        XCTAssertEqual(
            content,
            ShareCaptureContent.url(
                try XCTUnwrap(URL(string: "https://example.com/article"))
            )
        )

        let imageItems: [String: NSSecureCoding] = [
            UTType.image.identifier: Data([0x00]) as NSData,
        ]
        let image = MockShareProvider(items: imageItems)
        await XCTAssertThrowsErrorAsync(
            try await ShareItemExtractor.extract(from: [image])
        ) { error in
            XCTAssertEqual(error as? ShareCaptureInputError, .imageUnavailable)
        }
    }

    func testStrictlyValidatesTypesSchemesAndSizes() async throws {
        let remoteHTTPItems: [String: NSSecureCoding] = [
            UTType.url.identifier: try XCTUnwrap(NSURL(string: "http://example.com")),
        ]
        let remoteHTTP = MockShareProvider(items: remoteHTTPItems)
        await XCTAssertThrowsErrorAsync(
            try await ShareItemExtractor.extract(from: [remoteHTTP])
        )

        let blankItems: [String: NSSecureCoding] = [
            UTType.plainText.identifier: " \n " as NSString,
        ]
        let blank = MockShareProvider(items: blankItems)
        await XCTAssertThrowsErrorAsync(
            try await ShareItemExtractor.extract(from: [blank])
        )

        XCTAssertThrowsError(
            try ShareCapturePayload.encode(
                ShareCaptureSubmission(
                    content: .text(String(repeating: "x", count: 100_001))
                )
            )
        )
        XCTAssertNoThrow(
            try ShareCapturePayload.encode(
                ShareCaptureSubmission(content: .text("valid text"))
            )
        )
        XCTAssertFalse(
            ShareCaptureValidation.isValidURL(
                try XCTUnwrap(URL(string: "https://bad_host.example"))
            )
        )
        XCTAssertFalse(
            ShareCaptureValidation.isValidURL(
                try XCTUnwrap(URL(string: "https://example.com./article"))
            )
        )
    }

    func testMapsCanonicalURLAndTextPayloads() throws {
        let requestId = try XCTUnwrap(
            UUID(uuidString: "8cf177a0-e46a-46fa-824c-4c34004e2423")
        )
        let capturedAt = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-31T12:00:00Z")
        )
        let urlData = try ShareCapturePayload.encode(
            ShareCaptureSubmission(
                requestId: requestId,
                content: .url(
                    try XCTUnwrap(URL(string: "https://example.com/article")),
                    title: "Article",
                    sharedText: "Selected"
                ),
                capturedAt: capturedAt
            )
        )
        let textData = try ShareCapturePayload.encode(
            ShareCaptureSubmission(
                requestId: requestId,
                content: .text("Draft priorities"),
                capturedAt: capturedAt
            )
        )
        let url = try XCTUnwrap(
            JSONSerialization.jsonObject(with: urlData) as? [String: Any]
        )
        let text = try XCTUnwrap(
            JSONSerialization.jsonObject(with: textData) as? [String: Any]
        )

        XCTAssertEqual(url["version"] as? Int, 1)
        XCTAssertEqual(url["client"] as? String, "ios")
        XCTAssertEqual(url["contentType"] as? String, "url")
        XCTAssertEqual(url["url"] as? String, "https://example.com/article")
        XCTAssertEqual(url["sharedText"] as? String, "Selected")
        XCTAssertEqual(text["contentType"] as? String, "text")
        XCTAssertEqual(text["text"] as? String, "Draft priorities")
        XCTAssertNil(text["url"])
    }

    func testCredentialPersistsAcrossLifecycleAndIsRemovedOnLogoutOrRevocation() throws {
        let store = InMemoryCredentialStore()
        let completionStore = InMemoryCompletionStore(values: [
            ShareCaptureCompletion(requestId: UUID(), status: .created, itemId: "item"),
        ])
        let credential = ShareCaptureCredential(
            credentialId: UUID(),
            token: "secret-token",
            expiresAt: Date().addingTimeInterval(3_600)
        )
        try NativeShareCredentialLifecycle(store: store).install(credential)
        XCTAssertEqual(try store.read(), credential)

        try NativeShareCredentialLifecycle(
            store: store,
            completionStore: completionStore
        ).logout()
        XCTAssertNil(try store.read())
        XCTAssertTrue(completionStore.values.isEmpty)
        try store.write(credential)
        completionStore.append(
            ShareCaptureCompletion(requestId: UUID(), status: .duplicate, itemId: "item")
        )
        try NativeShareCredentialLifecycle(
            store: store,
            completionStore: completionStore
        ).revoke()
        XCTAssertNil(try store.read())
        XCTAssertTrue(completionStore.values.isEmpty)
    }

    func testCompletionRelayEmitsOnlyAcknowledgedStatusMetadata() {
        let completion = ShareCaptureCompletion(
            requestId: UUID(),
            status: .duplicate,
            itemId: "item-id"
        )
        let store = InMemoryCompletionStore(values: [completion])
        let sender = RecordingNativeEventSender()

        ShareCaptureCompletionRelay(store: store).deliverPending(to: sender)

        XCTAssertEqual(sender.captureCompletions, [completion])
        XCTAssertTrue(store.values.isEmpty)
    }
}

@MainActor
private final class MockShareProvider: ShareItemProviding {
    let items: [String: NSSecureCoding]

    init(items: [String: NSSecureCoding]) {
        self.items = items
    }

    func hasItemConforming(to typeIdentifier: String) -> Bool {
        items[typeIdentifier] != nil
    }

    func loadShareItem(for typeIdentifier: String) async throws -> NSSecureCoding {
        guard let item = items[typeIdentifier] else {
            throw ShareCaptureInputError.invalidInput
        }
        return item
    }
}

private final class InMemoryCredentialStore: ShareCaptureCredentialStoring {
    private var value: ShareCaptureCredential?

    func read() throws -> ShareCaptureCredential? { value }
    func write(_ credential: ShareCaptureCredential) throws { value = credential }
    func remove() throws { value = nil }
}

private final class InMemoryCompletionStore: ShareCaptureCompletionStoring {
    var values: [ShareCaptureCompletion]

    init(values: [ShareCaptureCompletion]) {
        self.values = values
    }

    func append(_ completion: ShareCaptureCompletion) {
        values.append(completion)
    }

    func consumeAll() -> [ShareCaptureCompletion] {
        defer { values.removeAll() }
        return values
    }

    func removeAll() {
        values.removeAll()
    }
}

@MainActor
private final class RecordingNativeEventSender: NativeBridgeEventSending {
    var captureCompletions: [ShareCaptureCompletion] = []

    func networkStatusDidChange(_ status: NetworkStatus) {}
    func authenticationDidChange(_ state: NativeAuthenticationState) {}
    func pushRegistrationDidChange(
        authorization: PushAuthorizationState,
        state: PushRegistrationState,
        registrationId: UUID?
    ) {}

    func shareCaptureDidComplete(
        requestId: UUID,
        status: ShareCaptureStatus,
        itemId: String
    ) {
        captureCompletions.append(
            ShareCaptureCompletion(
                requestId: requestId,
                status: status == .created ? .created : .duplicate,
                itemId: itemId
            )
        )
    }
}

private func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    _ errorHandler: (Error) -> Void = { _ in },
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected error", file: file, line: line)
    } catch {
        errorHandler(error)
    }
}
