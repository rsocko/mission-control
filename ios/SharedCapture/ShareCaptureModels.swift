import Foundation
import Network

enum ShareCaptureContent: Equatable, Sendable {
    case url(URL, title: String? = nil, sharedText: String? = nil)
    case text(String, title: String? = nil)
}

struct ShareCaptureSubmission: Equatable, Sendable {
    let requestId: UUID
    let content: ShareCaptureContent
    let capturedAt: Date

    init(
        requestId: UUID = UUID(),
        content: ShareCaptureContent,
        capturedAt: Date = Date()
    ) {
        self.requestId = requestId
        self.content = content
        self.capturedAt = capturedAt
    }
}

struct ShareCaptureCredential: Codable, Equatable, Sendable {
    let credentialId: UUID
    let token: String
    let expiresAt: Date

    var isExpired: Bool {
        expiresAt <= Date()
    }
}

enum ShareCaptureOutcome: Equatable, Sendable {
    case created(itemId: String)
    case duplicate(itemId: String)
    case invalidInput
    case offline
    case timeout
    case expiredAuthentication
    case serverFailure(retryable: Bool)

    var isRetryable: Bool {
        switch self {
        case .offline, .timeout:
            true
        case let .serverFailure(retryable):
            retryable
        case .created, .duplicate, .invalidInput, .expiredAuthentication:
            false
        }
    }
}

struct ShareCaptureCompletion: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable {
        case created
        case duplicate
    }

    let requestId: UUID
    let status: Status
    let itemId: String
}

enum ShareCaptureInputError: Error, Equatable {
    case invalidInput
    case imageUnavailable
}

enum ShareCapturePayload {
    static let version = 1
    static let maximumURLCodePoints = 2_048
    static let maximumTextCodePoints = 100_000
    static let maximumTitleCodePoints = 500

    static func encode(_ submission: ShareCaptureSubmission) throws -> Data {
        var object: [String: Any] = [
            "version": version,
            "requestId": submission.requestId.uuidString.lowercased(),
            "client": "ios",
            "capturedAt": ISO8601DateFormatter.capture.string(from: submission.capturedAt),
        ]
        switch submission.content {
        case let .url(url, title, sharedText):
            guard ShareCaptureValidation.isValidURL(url) else {
                throw ShareCaptureInputError.invalidInput
            }
            object["contentType"] = "url"
            object["url"] = url.absoluteString
            if let title {
                object["title"] = try validatedOptional(
                    title,
                    maximumCodePoints: maximumTitleCodePoints
                )
            }
            if let sharedText {
                object["sharedText"] = try validatedOptional(
                    sharedText,
                    maximumCodePoints: maximumTextCodePoints
                )
            }
        case let .text(text, title):
            object["contentType"] = "text"
            object["text"] = try ShareCaptureValidation.normalizedText(text)
            if let title {
                object["title"] = try validatedOptional(
                    title,
                    maximumCodePoints: maximumTitleCodePoints
                )
            }
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private static func validatedOptional(
        _ value: String,
        maximumCodePoints: Int
    ) throws -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              normalized.unicodeScalars.count <= maximumCodePoints
        else {
            throw ShareCaptureInputError.invalidInput
        }
        return normalized
    }
}

enum ShareCaptureValidation {
    static func normalizedText(_ value: String) throws -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              normalized.unicodeScalars.count <= ShareCapturePayload.maximumTextCodePoints
        else {
            throw ShareCaptureInputError.invalidInput
        }
        return normalized
    }

    static func isValidURL(_ url: URL) -> Bool {
        let value = url.absoluteString
        guard value.unicodeScalars.count <= ShareCapturePayload.maximumURLCodePoints,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil,
              components.password == nil,
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              isCanonicalHost(host),
              components.port.map({ (1 ... 65_535).contains($0) }) ?? true
        else {
            return false
        }
        if scheme == "https" {
            return true
        }
        return scheme == "http"
            && ["localhost", "127.0.0.1", "::1"].contains(host)
    }

    private static func isCanonicalHost(_ host: String) -> Bool {
        guard !host.isEmpty, !host.hasSuffix(".") else { return false }
        if host.contains(":") {
            return !host.contains("%") && IPv6Address(host) != nil
        }
        if host.allSatisfy({ $0.isNumber || $0 == "." }) {
            let octets = host.split(separator: ".", omittingEmptySubsequences: false)
            return octets.count == 4 && octets.allSatisfy { octet in
                guard !octet.isEmpty,
                      octet.count == 1 || octet.first != "0",
                      let value = Int(octet)
                else {
                    return false
                }
                return (0 ... 255).contains(value)
            }
        }
        guard host.count <= 253 else { return false }
        return host.split(separator: ".", omittingEmptySubsequences: false)
            .allSatisfy { label in
                guard !label.isEmpty,
                      label.count <= 63,
                      (label.first?.isLetter == true || label.first?.isNumber == true),
                      (label.last?.isLetter == true || label.last?.isNumber == true)
                else {
                    return false
                }
                return label.allSatisfy {
                    $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-")
                }
            }
    }
}

private extension ISO8601DateFormatter {
    static let capture: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
