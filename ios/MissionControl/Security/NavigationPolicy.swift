import Foundation

enum NavigationDisposition: Equatable {
    case allowInWebView
    case openExternally
    case block
}

struct NavigationPolicy {
    static let allowedTopLevelPaths: Set<String> = [
        "/",
        "/ai",
        "/capture",
        "/goals",
        "/insights",
        "/notifications",
        "/projects",
        "/quick-sort",
        "/routines",
        "/settings",
        "/today",
        "/triage",
    ]

    let trustedOrigin: TrustedOrigin

    func classifyTopLevel(_ url: URL) -> NavigationDisposition {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else {
            return .block
        }
        guard trustedOrigin.matches(url) else {
            return .openExternally
        }
        return Self.isAllowedTopLevelPath(url) ? .allowInWebView : .block
    }

    static func isAllowedTopLevelPath(_ url: URL) -> Bool {
        guard let components = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        ),
            let decodedPath = components.percentEncodedPath.removingPercentEncoding,
            decodedPath.isEmpty || decodedPath.hasPrefix("/"),
            !decodedPath.contains("\\"),
            decodedPath.rangeOfCharacter(from: .controlCharacters) == nil,
            !containsDotSegment(decodedPath)
        else {
            return false
        }

        if decodedPath.isEmpty || decodedPath == "/" {
            return true
        }
        return allowedTopLevelPaths
            .filter { $0 != "/" }
            .contains { decodedPath == $0 || decodedPath.hasPrefix("\($0)/") }
    }

    static func isSafeWebScheme(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }

    static func isSafeExternalURL(_ url: URL) -> Bool {
        guard isSafeWebScheme(url),
              let components = URLComponents(
                  url: url,
                  resolvingAgainstBaseURL: false
              ),
              components.user == nil,
              components.password == nil,
              let host = components.host?.lowercased(),
              !host.contains(":"),
              TrustedOrigin.isCanonicalHost(host),
              components.port.map({ (1 ... 65_535).contains($0) }) ?? true
        else {
            return false
        }
        return true
    }

    private static func containsDotSegment(_ path: String) -> Bool {
        path.split(separator: "/", omittingEmptySubsequences: false)
            .contains { $0 == "." || $0 == ".." }
    }
}
