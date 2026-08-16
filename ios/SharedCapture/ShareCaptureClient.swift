import Foundation

final class ShareCaptureClient: @unchecked Sendable {
    private let session: URLSession
    private let endpoint: URL
    private let timeout: TimeInterval

    init(session: URLSession = .shared, baseURL: URL, timeout: TimeInterval = 15) {
        self.session = session
        endpoint = baseURL.appendingPathComponent("api/triage/capture")
        self.timeout = timeout
    }

    func submit(
        _ submission: ShareCaptureSubmission,
        credential: ShareCaptureCredential
    ) async -> ShareCaptureOutcome {
        guard !credential.isExpired else {
            return .expiredAuthentication
        }

        let body: Data
        do {
            body = try ShareCapturePayload.encode(submission)
        } catch {
            return .invalidInput
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(
            "Bearer \(credential.token)",
            forHTTPHeaderField: "Authorization"
        )
        request.setValue(
            submission.requestId.uuidString.lowercased(),
            forHTTPHeaderField: "Idempotency-Key"
        )

        do {
            let (data, response) = try await session.data(for: request)
            guard data.count <= 64 * 1_024,
                  let response = response as? HTTPURLResponse
            else {
                return .serverFailure(retryable: true)
            }
            return Self.mapResponse(
                statusCode: response.statusCode,
                data: data,
                requestId: submission.requestId
            )
        } catch let error as URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
                 .cannotFindHost, .dnsLookupFailed:
                return .offline
            case .timedOut:
                return .timeout
            default:
                return .serverFailure(retryable: true)
            }
        } catch {
            return .serverFailure(retryable: true)
        }
    }

    private static func mapResponse(
        statusCode: Int,
        data: Data,
        requestId: UUID
    ) -> ShareCaptureOutcome {
        let decoder = JSONDecoder()
        if (200 ... 299).contains(statusCode),
           let response = try? decoder.decode(SuccessResponse.self, from: data),
           response.version == 1,
           response.requestId == requestId,
           response.ok,
           !response.data.itemId.isEmpty,
           response.data.itemId.unicodeScalars.count <= 128
        {
            switch response.data.status {
            case .created:
                return .created(itemId: response.data.itemId)
            case .duplicate:
                return .duplicate(itemId: response.data.itemId)
            }
        }

        if let response = try? decoder.decode(ErrorResponse.self, from: data),
           response.version == 1,
           response.requestId == requestId,
           !response.ok
        {
            switch response.error.code {
            case .invalidRequest, .imageCaptureUnavailable, .replayDetected:
                return .invalidInput
            case .unauthorized, .forbidden, .tokenExpired:
                return .expiredAuthentication
            case .rateLimited, .internalError:
                return .serverFailure(retryable: response.error.retryable)
            }
        }
        return .serverFailure(retryable: statusCode >= 500 || statusCode == 429)
    }
}

private struct SuccessResponse: Decodable {
    struct Payload: Decodable {
        enum Status: String, Decodable {
            case created
            case duplicate
        }

        let itemId: String
        let status: Status
    }

    let version: Int
    let requestId: UUID
    let ok: Bool
    let data: Payload
}

private struct ErrorResponse: Decodable {
    struct Payload: Decodable {
        enum Code: String, Decodable {
            case invalidRequest = "INVALID_REQUEST"
            case unauthorized = "UNAUTHORIZED"
            case forbidden = "FORBIDDEN"
            case tokenExpired = "TOKEN_EXPIRED"
            case replayDetected = "REPLAY_DETECTED"
            case rateLimited = "RATE_LIMITED"
            case imageCaptureUnavailable = "IMAGE_CAPTURE_UNAVAILABLE"
            case internalError = "INTERNAL_ERROR"
        }

        let code: Code
        let retryable: Bool
    }

    let version: Int
    let requestId: UUID
    let ok: Bool
    let error: Payload
}
