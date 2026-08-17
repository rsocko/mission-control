import Foundation
import Network

enum TrustedOriginError: LocalizedError, Equatable {
    case empty
    case invalidURL
    case unsupportedScheme
    case insecureRemoteOrigin
    case credentialsNotAllowed
    case nonOriginComponents
    case invalidHost
    case invalidPort

    var errorDescription: String? {
        switch self {
        case .empty:
            "The origin is empty."
        case .invalidURL:
            "The origin is not a valid absolute URL."
        case .unsupportedScheme:
            "Only HTTPS origins and loopback HTTP origins are supported."
        case .insecureRemoteOrigin:
            "HTTP is allowed only for localhost and loopback development origins."
        case .credentialsNotAllowed:
            "Credentials are not allowed in an origin."
        case .nonOriginComponents:
            "An origin cannot contain a path, query, or fragment."
        case .invalidHost:
            "The origin host is not canonical."
        case .invalidPort:
            "The origin port is invalid."
        }
    }
}

struct TrustedOrigin: Equatable, Sendable {
    let scheme: String
    let host: String
    let port: Int?
    let url: URL

    var serialized: String {
        url.absoluteString
    }

    init(_ value: String) throws {
        guard !value.isEmpty else {
            throw TrustedOriginError.empty
        }
        guard value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              let components = URLComponents(string: value),
              components.url != nil,
              components.scheme != nil,
              components.host != nil
        else {
            throw TrustedOriginError.invalidURL
        }
        guard components.user == nil, components.password == nil else {
            throw TrustedOriginError.credentialsNotAllowed
        }
        guard components.path.isEmpty || components.path == "/",
              components.query == nil,
              components.fragment == nil
        else {
            throw TrustedOriginError.nonOriginComponents
        }

        let normalizedScheme = components.scheme?.lowercased() ?? ""
        let normalizedHost = Self.normalizeHost(components.host?.lowercased() ?? "")
        guard Self.isCanonicalHost(normalizedHost) else {
            throw TrustedOriginError.invalidHost
        }
        guard normalizedScheme == "https" || normalizedScheme == "http" else {
            throw TrustedOriginError.unsupportedScheme
        }
        if normalizedScheme == "http", !Self.isLoopback(normalizedHost) {
            throw TrustedOriginError.insecureRemoteOrigin
        }

        let normalizedPort = try Self.normalizedPort(
            components.port,
            scheme: normalizedScheme
        )
        var normalized = URLComponents()
        normalized.scheme = normalizedScheme
        normalized.host = normalizedHost.contains(":")
            ? "[\(normalizedHost)]"
            : normalizedHost
        normalized.port = normalizedPort
        guard let normalizedURL = normalized.url else {
            throw TrustedOriginError.invalidURL
        }

        scheme = normalizedScheme
        host = normalizedHost
        port = normalizedPort
        url = normalizedURL
    }

    func matches(_ candidate: URL) -> Bool {
        guard let components = URLComponents(
            url: candidate,
            resolvingAgainstBaseURL: false
        ),
            components.user == nil,
            components.password == nil,
            let candidateScheme = components.scheme?.lowercased(),
            let rawCandidateHost = components.host?.lowercased()
        else {
            return false
        }
        let candidateHost = Self.normalizeHost(rawCandidateHost)
        guard Self.isCanonicalHost(candidateHost) else { return false }
        let candidatePort: Int?
        do {
            candidatePort = try Self.normalizedPort(
                components.port,
                scheme: candidateScheme
            )
        } catch {
            return false
        }

        return candidateScheme == scheme
            && candidateHost == host
            && candidatePort == port
    }

    func url(path: String, percentEncodedQuery: String? = nil) -> URL? {
        guard path.hasPrefix("/") else { return nil }
        var components = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        )
        components?.percentEncodedPath = path
        components?.percentEncodedQuery = percentEncodedQuery
        return components?.url
    }

    private static func normalizedPort(_ port: Int?, scheme: String) throws -> Int? {
        guard let port else { return nil }
        guard (1 ... 65_535).contains(port) else {
            throw TrustedOriginError.invalidPort
        }
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) {
            return nil
        }
        return port
    }

    private static func isLoopback(_ host: String) -> Bool {
        host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    private static func normalizeHost(_ host: String) -> String {
        guard host.hasPrefix("["), host.hasSuffix("]") else { return host }
        return String(host.dropFirst().dropLast())
    }

    static func isCanonicalHost(_ host: String) -> Bool {
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
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        return labels.allSatisfy { label in
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
