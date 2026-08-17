import Foundation

struct DeepLinkRouter {
    let trustedOrigin: TrustedOrigin

    func destination(for incomingURL: URL) -> URL? {
        switch incomingURL.scheme?.lowercased() {
        case "mc":
            customSchemeDestination(for: incomingURL)
        case "http", "https":
            universalLinkDestination(for: incomingURL)
        default:
            nil
        }
    }

    private func universalLinkDestination(for incomingURL: URL) -> URL? {
        let policy = NavigationPolicy(trustedOrigin: trustedOrigin)
        guard policy.classifyTopLevel(incomingURL) == .allowInWebView else {
            return nil
        }
        return incomingURL
    }

    private func customSchemeDestination(for incomingURL: URL) -> URL? {
        guard let components = URLComponents(
            url: incomingURL,
            resolvingAgainstBaseURL: false
        ),
            components.scheme?.lowercased() == "mc",
            components.user == nil,
            components.password == nil,
            components.port == nil,
            components.fragment == nil,
            let host = components.host?.lowercased()
        else {
            return nil
        }

        let destinationPath: String?
        switch (host, components.path) {
        case ("view", "/today"):
            destinationPath = "/today"
        case ("view", "/triage"):
            destinationPath = "/triage"
        case ("view", "/capture"), ("capture", ""), ("capture", "/"):
            destinationPath = "/capture"
        case ("view", "/quick-sort"):
            destinationPath = "/quick-sort"
        case ("view", "/houston"):
            destinationPath = "/ai"
        default:
            destinationPath = nil
        }

        guard let destinationPath else { return nil }
        return trustedOrigin.url(
            path: destinationPath,
            percentEncodedQuery: components.percentEncodedQuery
        )
    }
}
