import UIKit
import WebKit

@MainActor
final class WebViewController: UIViewController {
    private let trustedOrigin: TrustedOrigin
    private let navigationPolicy: NavigationPolicy
    private let deepLinkRouter: DeepLinkRouter
    private let externalURLOpener: ExternalURLOpening
    private let networkMonitor: NetworkStatusMonitoring
    private let eventDispatcher: NativeEventDispatching
    private let shareCaptureEventSender: NativeBridgeEventSending
    private let bridge: WebBridge
    private let webView: WKWebView
    private let networkStatusLabel = UILabel()

    private var recoveryURL: URL
    private var isShowingOfflineFallback = false
    private var lastNetworkStatus: NetworkStatus?

    init(
        configuration: AppConfiguration,
        externalURLOpener: ExternalURLOpening? = nil,
        networkMonitor: NetworkStatusMonitoring = NetworkMonitor(),
        eventDispatcher: NativeEventDispatching? = nil,
        actionHandler: NativeBridgeActionHandling? = nil,
        bundle: Bundle = .main
    ) {
        trustedOrigin = configuration.trustedOrigin
        navigationPolicy = NavigationPolicy(trustedOrigin: configuration.trustedOrigin)
        deepLinkRouter = DeepLinkRouter(trustedOrigin: configuration.trustedOrigin)
        self.externalURLOpener = externalURLOpener ?? SafariExternalURLOpener()
        self.networkMonitor = networkMonitor
        recoveryURL = configuration.trustedOrigin.url

        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.websiteDataStore = .default()
        webConfiguration.userContentController.addUserScript(
            NativeContextScript.userScript(trustedOrigin: configuration.trustedOrigin)
        )
        webConfiguration.userContentController.addUserScript(
            WebBridgeScript.userScript(trustedOrigin: configuration.trustedOrigin)
        )
        webConfiguration.applicationNameForUserAgent = Self.diagnosticUserAgent(bundle: bundle)
        let resolvedActionHandler = actionHandler
            ?? SystemNativeBridgeActionHandler(bundle: bundle)
        let bridge = WebBridge(
            trustedOrigin: configuration.trustedOrigin,
            actionHandler: resolvedActionHandler
        )
        self.bridge = bridge
        self.eventDispatcher = eventDispatcher ?? bridge
        shareCaptureEventSender = bridge
        let webView = WKWebView(frame: .zero, configuration: webConfiguration)
        // CSS env(safe-area-inset-*) owns edge-to-edge layout for trusted app content.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        self.webView = webView

        super.init(nibName: nil, bundle: nil)
        bridge.attach(
            webView: webView,
            userContentController: webConfiguration.userContentController
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        configureNetworkStatusLabel()
        view.addSubview(networkStatusLabel)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            networkStatusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            networkStatusLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])

        networkMonitor.statusHandler = { [weak self] status in
            self?.handleNetworkStatus(status)
        }
        networkMonitor.start()
        webView.load(URLRequest(url: recoveryURL))
    }

    deinit {
        networkMonitor.cancel()
    }

    func tearDown() {
        networkMonitor.cancel()
        networkMonitor.statusHandler = nil
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        bridge.tearDown()
    }

    func openValidatedLink(_ incomingURL: URL) {
        guard let destination = deepLinkRouter.destination(for: incomingURL) else {
            return
        }

        recoveryURL = destination
        isShowingOfflineFallback = false
        loadWhenReady(destination)
    }

    var nativeBridgeEventSender: NativeBridgeEventSending {
        shareCaptureEventSender
    }

    static func offlineURL(for trustedOrigin: TrustedOrigin) -> URL {
        trustedOrigin.url(path: "/~offline") ?? trustedOrigin.url
    }

    private func loadWhenReady(_ url: URL) {
        guard isViewLoaded else {
            recoveryURL = url
            return
        }
        webView.load(URLRequest(url: url))
    }

    private func configureNetworkStatusLabel() {
        networkStatusLabel.backgroundColor = .systemOrange
        networkStatusLabel.textColor = .label
        networkStatusLabel.font = .preferredFont(forTextStyle: .caption1)
        networkStatusLabel.text = "Offline"
        networkStatusLabel.textAlignment = .center
        networkStatusLabel.layer.cornerRadius = 10
        networkStatusLabel.layer.masksToBounds = true
        networkStatusLabel.isAccessibilityElement = true
        networkStatusLabel.accessibilityLabel = "Network status: offline"
        networkStatusLabel.isHidden = true
        networkStatusLabel.translatesAutoresizingMaskIntoConstraints = false
        networkStatusLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 72).isActive = true
        networkStatusLabel.heightAnchor.constraint(equalToConstant: 24).isActive = true
    }

    private func handleNetworkStatus(_ status: NetworkStatus) {
        let shouldReload = Self.shouldReloadAfterNetworkTransition(
            from: lastNetworkStatus,
            to: status
        )
        lastNetworkStatus = status
        eventDispatcher.networkStatusDidChange(status)
        networkStatusLabel.isHidden = status == .online

        if shouldReload {
            isShowingOfflineFallback = false
            let reloadURL = Self.reconnectURL(
                currentURL: webView.url,
                recoveryURL: recoveryURL,
                navigationPolicy: navigationPolicy
            )
            recoveryURL = reloadURL
            webView.load(URLRequest(url: reloadURL))
        }
    }

    static func shouldReloadAfterNetworkTransition(
        from previousStatus: NetworkStatus?,
        to status: NetworkStatus
    ) -> Bool {
        previousStatus == .offline && status == .online
    }

    static func reconnectURL(
        currentURL: URL?,
        recoveryURL: URL,
        navigationPolicy: NavigationPolicy
    ) -> URL {
        guard let currentURL,
              navigationPolicy.classifyTopLevel(currentURL) == .allowInWebView
        else {
            return recoveryURL
        }
        return currentURL
    }

    private func loadOfflineFallback(after error: Error) {
        guard Self.isNetworkFailure(error), !isShowingOfflineFallback else {
            return
        }

        // A provisional failure means WebKit and the service worker could not
        // satisfy the original request. Only then request the cached fallback.
        isShowingOfflineFallback = true
        bridge.deactivate()
        let offlineURL = Self.offlineURL(for: trustedOrigin)
        webView.load(
            URLRequest(
                url: offlineURL,
                cachePolicy: .returnCacheDataElseLoad,
                timeoutInterval: 15
            )
        )
    }

    private func isOfflineFallback(_ url: URL) -> Bool {
        url == Self.offlineURL(for: trustedOrigin)
    }

    private static func isNetworkFailure(_ error: Error) -> Bool {
        let error = error as NSError
        guard error.domain == NSURLErrorDomain else { return false }
        return [
            NSURLErrorCannotConnectToHost,
            NSURLErrorCannotFindHost,
            NSURLErrorDNSLookupFailed,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorNotConnectedToInternet,
            NSURLErrorTimedOut,
        ].contains(error.code)
    }

    private static func diagnosticUserAgent(bundle: Bundle) -> String {
        let version = diagnosticToken(
            bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        )
        let build = diagnosticToken(
            bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        )
        return "MissionControlNative/iOS \(version) (\(build))"
    }

    private static func diagnosticToken(_ value: String?) -> String {
        let allowed = CharacterSet.alphanumerics.union(
            CharacterSet(charactersIn: ".-_")
        )
        let sanitized = (value ?? "unknown").unicodeScalars
            .filter { allowed.contains($0) }
            .map(String.init)
            .joined()
        return sanitized.isEmpty ? "unknown" : sanitized
    }

    static func shouldGrantMediaCapturePermission(
        origin: URL?,
        isMainFrame: Bool,
        type: WKMediaCaptureType,
        trustedOrigin: TrustedOrigin
    ) -> Bool {
        guard isMainFrame,
              let origin,
              trustedOrigin.matches(origin)
        else {
            return false
        }

        if case .microphone = type {
            return true
        }
        return false
    }

    private static func mediaCaptureURL(for origin: WKSecurityOrigin) -> URL? {
        var components = URLComponents()
        components.scheme = origin.protocol
        components.host = origin.host.contains(":")
            ? "[\(origin.host)]"
            : origin.host
        if origin.port != 0 {
            components.port = origin.port
        }
        return components.url
    }
}

extension WebViewController: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }

        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(NavigationPolicy.isSafeWebScheme(url) ? .allow : .cancel)
            return
        }

        if isShowingOfflineFallback, isOfflineFallback(url) {
            bridge.deactivate()
            decisionHandler(.allow)
            return
        }

        switch navigationPolicy.classifyTopLevel(url) {
        case .allowInWebView:
            bridge.activate()
            recoveryURL = url
            isShowingOfflineFallback = false
            if navigationAction.targetFrame == nil {
                webView.load(navigationAction.request)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        case .openExternally:
            bridge.deactivate()
            externalURLOpener.open(url, from: self)
            decisionHandler(.cancel)
            restoreBridgeForCurrentDocument()
        case .block:
            bridge.deactivate()
            decisionHandler(.cancel)
            restoreBridgeForCurrentDocument()
        }
    }

    func webView(
        _ webView: WKWebView,
        didCommit navigation: WKNavigation?
    ) {
        synchronizeBridge(with: webView.url)
    }

    func webView(
        _ webView: WKWebView,
        didFinish navigation: WKNavigation?
    ) {
        synchronizeBridge(with: webView.url)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        loadOfflineFallback(after: error)
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation?,
        withError error: Error
    ) {
        loadOfflineFallback(after: error)
    }
}

extension WebViewController: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        let decision: WKPermissionDecision = Self.shouldGrantMediaCapturePermission(
            origin: Self.mediaCaptureURL(for: origin),
            isMainFrame: frame.isMainFrame,
            type: type,
            trustedOrigin: trustedOrigin
        ) ? .grant : .deny
        decisionHandler(decision)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        switch navigationPolicy.classifyTopLevel(url) {
        case .allowInWebView:
            bridge.activate()
            recoveryURL = url
            webView.load(navigationAction.request)
        case .openExternally:
            bridge.deactivate()
            externalURLOpener.open(url, from: self)
            restoreBridgeForCurrentDocument()
        case .block:
            bridge.deactivate()
            restoreBridgeForCurrentDocument()
        }
        return nil
    }
}

private extension WebViewController {
    func synchronizeBridge(with url: URL?) {
        guard let url,
              !isOfflineFallback(url),
              navigationPolicy.classifyTopLevel(url) == .allowInWebView
        else {
            bridge.deactivate()
            return
        }
        bridge.activate()
    }

    func restoreBridgeForCurrentDocument() {
        synchronizeBridge(with: webView.url)
    }
}
