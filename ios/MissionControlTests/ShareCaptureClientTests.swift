import XCTest
@testable import MissionControl

final class ShareCaptureClientTests: XCTestCase {
    private let requestId = UUID(uuidString: "8cf177a0-e46a-46fa-824c-4c34004e2423")!
    private var session: URLSession!

    override func setUp() {
        super.setUp()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        session = URLSession(configuration: configuration)
        StubURLProtocol.handler = nil
        StubURLProtocol.requests = []
    }

    override func tearDown() {
        session.invalidateAndCancel()
        StubURLProtocol.handler = nil
        StubURLProtocol.requests = []
        super.tearDown()
    }

    func testMapsCreatedAndDuplicateOnlyAfterAcknowledgement() async throws {
        StubURLProtocol.handler = { request in
            let requestId = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            return .response(
                status: 201,
                body: """
                {"version":1,"requestId":"\(requestId)","ok":true,\
                "data":{"itemId":"item-1","status":"created"}}
                """
            )
        }
        let created = await client().submit(submission(), credential: credential())
        XCTAssertEqual(created, .created(itemId: "item-1"))

        StubURLProtocol.handler = { request in
            let requestId = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            return .response(
                status: 200,
                body: """
                {"version":1,"requestId":"\(requestId)","ok":true,\
                "data":{"itemId":"item-1","status":"duplicate"}}
                """
            )
        }
        let duplicate = await client().submit(submission(), credential: credential())
        XCTAssertEqual(duplicate, .duplicate(itemId: "item-1"))
    }

    func testNeverReportsSuccessForMalformedOrMismatchedAcknowledgements() async {
        StubURLProtocol.handler = { _ in
            .response(
                status: 201,
                body: """
                {"version":1,"requestId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",\
                "ok":true,"data":{"itemId":"item-1","status":"created"}}
                """
            )
        }

        let outcome = await client().submit(submission(), credential: credential())

        XCTAssertEqual(outcome, .serverFailure(retryable: false))
    }

    func testMapsOfflineTimeoutExpiredAuthAndServerFailures() async {
        StubURLProtocol.handler = { _ in .failure(URLError(.notConnectedToInternet)) }
        let offline = await client().submit(submission(), credential: credential())
        XCTAssertEqual(offline, .offline)

        StubURLProtocol.handler = { _ in .failure(URLError(.timedOut)) }
        let timeout = await client().submit(submission(), credential: credential())
        XCTAssertEqual(timeout, .timeout)

        let expired = await client().submit(
            submission(),
            credential: credential(expiresAt: Date(timeIntervalSince1970: 1))
        )
        XCTAssertEqual(expired, .expiredAuthentication)

        StubURLProtocol.handler = { request in
            let requestId = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            return .response(
                status: 503,
                body: """
                {"version":1,"requestId":"\(requestId)","ok":false,\
                "error":{"code":"INTERNAL_ERROR","message":"Unavailable","retryable":true}}
                """
            )
        }
        let serverFailure = await client().submit(submission(), credential: credential())
        XCTAssertEqual(serverFailure, .serverFailure(retryable: true))
    }

    func testMapsInvalidAndExpiredServerErrorsExplicitly() async {
        StubURLProtocol.handler = { request in
            let requestId = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            return .response(
                status: 422,
                body: """
                {"version":1,"requestId":"\(requestId)","ok":false,\
                "error":{"code":"IMAGE_CAPTURE_UNAVAILABLE","message":"Unavailable",\
                "retryable":false}}
                """
            )
        }
        let invalid = await client().submit(submission(), credential: credential())
        XCTAssertEqual(invalid, .invalidInput)

        StubURLProtocol.handler = { request in
            let requestId = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            return .response(
                status: 401,
                body: """
                {"version":1,"requestId":"\(requestId)","ok":false,\
                "error":{"code":"TOKEN_EXPIRED","message":"Open the app","retryable":false}}
                """
            )
        }
        let expired = await client().submit(submission(), credential: credential())
        XCTAssertEqual(expired, .expiredAuthentication)
    }

    func testRetryReusesRequestIdPayloadAndIdempotencyKey() async throws {
        var attempt = 0
        StubURLProtocol.handler = { request in
            attempt += 1
            if attempt == 1 {
                return .failure(URLError(.timedOut))
            }
            let requestId = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            return .response(
                status: 200,
                body: """
                {"version":1,"requestId":"\(requestId)","ok":true,\
                "data":{"itemId":"item-1","status":"duplicate"}}
                """
            )
        }
        let submission = submission()

        let timeout = await client().submit(submission, credential: credential())
        XCTAssertEqual(timeout, .timeout)
        let duplicate = await client().submit(submission, credential: credential())
        XCTAssertEqual(duplicate, .duplicate(itemId: "item-1"))

        let requests = StubURLProtocol.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Idempotency-Key"),
            requestId.uuidString.lowercased()
        )
        XCTAssertEqual(requests[0].httpBody, requests[1].httpBody)
        XCTAssertEqual(
            requests[0].value(forHTTPHeaderField: "Authorization"),
            "Bearer secret-token"
        )
    }

    private func client() -> ShareCaptureClient {
        ShareCaptureClient(
            session: session,
            baseURL: URL(string: "https://mc.example.com")!,
            timeout: 1
        )
    }

    private func submission() -> ShareCaptureSubmission {
        ShareCaptureSubmission(
            requestId: requestId,
            content: .text("Private capture content"),
            capturedAt: Date(timeIntervalSince1970: 1_785_499_200)
        )
    }

    private func credential(
        expiresAt: Date = Date().addingTimeInterval(3_600)
    ) -> ShareCaptureCredential {
        ShareCaptureCredential(
            credentialId: UUID(uuidString: "83c45840-a47f-4269-aae9-5a3f4fbd220b")!,
            token: "secret-token",
            expiresAt: expiresAt
        )
    }
}

private final class StubURLProtocol: URLProtocol {
    enum Result {
        case response(status: Int, body: String)
        case failure(Error)
    }

    static var handler: ((URLRequest) throws -> Result)?
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        do {
            guard let result = try Self.handler?(request) else {
                throw URLError(.badServerResponse)
            }
            switch result {
            case let .response(status, body):
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: status,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                )!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: Data(body.utf8))
                client?.urlProtocolDidFinishLoading(self)
            case let .failure(error):
                client?.urlProtocol(self, didFailWithError: error)
            }
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
