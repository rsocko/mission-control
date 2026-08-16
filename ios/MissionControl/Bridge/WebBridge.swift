import Foundation
import WebKit

struct NativeBridgeMessageOrigin: Equatable {
    let scheme: String
    let host: String
    let port: Int?

    init(scheme: String, host: String, port: Int?) {
        self.scheme = scheme
        self.host = host
        self.port = port
    }

    init(_ origin: WKSecurityOrigin) {
        self.init(
            scheme: origin.protocol,
            host: origin.host,
            port: origin.port == 0 ? nil : origin.port
        )
    }

    func matches(_ trustedOrigin: TrustedOrigin) -> Bool {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host.contains(":") ? "[\(host)]" : host
        components.port = port
        guard let url = components.url else { return false }
        return trustedOrigin.matches(url)
    }
}

enum NativeBridgeMessageValidation: Equatable {
    case request(NativeBridgeRequest)
    case rejection(NativeBridgeResponse?)
}

enum NativeBridgeMessageValidator {
    static func validate(
        body: Any,
        isMainFrame: Bool,
        origin: NativeBridgeMessageOrigin,
        trustedOrigin: TrustedOrigin
    ) -> NativeBridgeMessageValidation {
        let metadata = metadata(from: body)
        guard isMainFrame, origin.matches(trustedOrigin) else {
            return .rejection(
                errorResponse(
                    metadata: metadata,
                    code: .untrustedOrigin,
                    message: "The bridge request did not come from the trusted main frame"
                )
            )
        }

        do {
            return .request(try NativeBridgeCodec.decodeRequest(from: body))
        } catch let error as NativeBridgeDecodingError {
            switch error {
            case .unsupportedVersion:
                return .rejection(
                    errorResponse(
                        metadata: metadata,
                        code: .unsupportedVersion,
                        message: "The bridge version is not supported"
                    )
                )
            case .unsupportedAction:
                return .rejection(
                    errorResponse(
                        metadata: metadata,
                        code: .unsupportedAction,
                        message: "The bridge action is not supported"
                    )
                )
            case .invalidMessage, .messageTooLarge:
                return .rejection(
                    errorResponse(
                        metadata: metadata,
                        code: .invalidMessage,
                        message: "The bridge request is invalid"
                    )
                )
            }
        } catch {
            return .rejection(
                errorResponse(
                    metadata: metadata,
                    code: .invalidMessage,
                    message: "The bridge request is invalid"
                )
            )
        }
    }

    private struct Metadata {
        let requestId: UUID?
        let action: String
    }

    private static func metadata(from body: Any) -> Metadata {
        guard let dictionary = body as? [String: Any] else {
            return Metadata(requestId: nil, action: "unknown")
        }
        let requestId = (dictionary["requestId"] as? String).flatMap(
            NativeBridgeUUID.parse
        )
        let candidate = dictionary["action"] as? String
        let action = candidate?.isEmpty == false
            && (candidate?.unicodeScalars.count ?? 0) <= 128
            ? candidate ?? "unknown"
            : "unknown"
        return Metadata(requestId: requestId, action: action)
    }

    private static func errorResponse(
        metadata: Metadata,
        code: NativeBridgeErrorCode,
        message: String
    ) -> NativeBridgeResponse? {
        guard let requestId = metadata.requestId else { return nil }
        return .failure(
            requestId: requestId,
            action: metadata.action,
            error: NativeBridgeError(code: code, message: message, retryable: false)
        )
    }
}

@MainActor
protocol NativeBridgeEventSending: NativeEventDispatching {
    func authenticationDidChange(_ state: NativeAuthenticationState)
    func pushRegistrationDidChange(
        authorization: PushAuthorizationState,
        state: PushRegistrationState,
        registrationId: UUID?
    )
    func shareCaptureDidComplete(
        requestId: UUID,
        status: ShareCaptureStatus,
        itemId: String
    )
}

@MainActor
final class WebBridge: NSObject, NativeBridgeEventSending {
    private let trustedOrigin: TrustedOrigin
    private let navigationPolicy: NavigationPolicy
    private let actionHandler: NativeBridgeActionHandling
    private let proxy = WeakScriptMessageHandler()

    private weak var webView: WKWebView?
    private weak var userContentController: WKUserContentController?
    private var inFlight: [UUID: Task<Void, Never>] = [:]
    private var generation = 0

    private(set) var isHandlerInstalled = false

    init(
        trustedOrigin: TrustedOrigin,
        actionHandler: NativeBridgeActionHandling
    ) {
        self.trustedOrigin = trustedOrigin
        navigationPolicy = NavigationPolicy(trustedOrigin: trustedOrigin)
        self.actionHandler = actionHandler
        super.init()
        proxy.target = self
    }

    func attach(
        webView: WKWebView,
        userContentController: WKUserContentController
    ) {
        self.webView = webView
        self.userContentController = userContentController
        activate()
    }

    func activate() {
        guard !isHandlerInstalled, let userContentController else { return }
        userContentController.add(proxy, name: WebBridgeScript.handlerName)
        isHandlerInstalled = true
        generation += 1
    }

    func deactivate() {
        guard isHandlerInstalled else { return }
        userContentController?.removeScriptMessageHandler(
            forName: WebBridgeScript.handlerName
        )
        isHandlerInstalled = false
        generation += 1
        inFlight.values.forEach { $0.cancel() }
        inFlight.removeAll()
    }

    func tearDown() {
        deactivate()
        actionHandler.tearDown()
        webView = nil
        userContentController = nil
        proxy.target = nil
    }

    func networkStatusDidChange(_ status: NetworkStatus) {
        send(event: NativeBridgeEvent(payload: .networkStatus(status)))
    }

    func authenticationDidChange(_ state: NativeAuthenticationState) {
        send(event: NativeBridgeEvent(payload: .authenticationChanged(state)))
    }

    func pushRegistrationDidChange(
        authorization: PushAuthorizationState,
        state: PushRegistrationState,
        registrationId: UUID?
    ) {
        guard (state == .registered) == (registrationId != nil) else { return }
        send(
            event: NativeBridgeEvent(
                payload: .pushRegistrationChanged(
                    authorization: authorization,
                    state: state,
                    registrationId: registrationId
                )
            )
        )
    }

    func shareCaptureDidComplete(
        requestId: UUID,
        status: ShareCaptureStatus,
        itemId: String
    ) {
        send(
            event: NativeBridgeEvent(
                payload: .shareCaptureCompleted(
                    captureRequestId: requestId,
                    status: status,
                    itemId: itemId
                )
            )
        )
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard isHandlerInstalled else { return }
        let validation = NativeBridgeMessageValidator.validate(
            body: message.body,
            isMainFrame: message.frameInfo.isMainFrame,
            origin: NativeBridgeMessageOrigin(message.frameInfo.securityOrigin),
            trustedOrigin: trustedOrigin
        )
        switch validation {
        case let .rejection(response):
            if let response {
                send(response: response)
            }
        case let .request(request):
            handle(request)
        }
    }

    private func handle(_ request: NativeBridgeRequest) {
        guard inFlight[request.requestId] == nil else {
            send(
                response: .failure(
                    requestId: request.requestId,
                    action: request.action.rawValue,
                    error: NativeBridgeError(
                        code: .invalidMessage,
                        message: "The bridge request ID is already in use",
                        retryable: false
                    )
                )
            )
            return
        }

        let requestGeneration = generation
        let task = Task { [weak self] in
            guard let self else { return }
            let outcome = await actionHandler.handle(request)
            inFlight[request.requestId] = nil
            guard !Task.isCancelled,
                  isHandlerInstalled,
                  generation == requestGeneration
            else {
                return
            }
            switch outcome {
            case let .success(result):
                guard result.action == request.action else {
                    send(
                        response: .failure(
                            requestId: request.requestId,
                            action: request.action.rawValue,
                            error: NativeBridgeError(
                                code: .nativeFailure,
                                message: "The native action returned an invalid result",
                                retryable: false
                            )
                        )
                    )
                    return
                }
                send(response: .success(requestId: request.requestId, result: result))
            case let .failure(error):
                send(
                    response: .failure(
                        requestId: request.requestId,
                        action: request.action.rawValue,
                        error: error
                    )
                )
            }
        }
        inFlight[request.requestId] = task
    }

    private func send(response: NativeBridgeResponse) {
        sendToPage(response)
    }

    private func send(event: NativeBridgeEvent) {
        guard canDispatchEvent else { return }
        sendToPage(event)
    }

    private var canDispatchEvent: Bool {
        guard isHandlerInstalled,
              let url = webView?.url
        else {
            return false
        }
        return navigationPolicy.classifyTopLevel(url) == .allowInWebView
    }

    private func sendToPage<Value: Encodable>(_ value: Value) {
        guard isHandlerInstalled,
              let webView,
              let object = try? NativeBridgeCodec.jsonObject(for: value)
        else {
            return
        }
        Task { @MainActor [weak webView] in
            _ = try? await webView?.callAsyncJavaScript(
                "window.\(WebBridgeScript.receiverName)?.(message)",
                arguments: ["message": object],
                in: nil,
                contentWorld: .page
            )
        }
    }
}

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WebBridge?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        Task { @MainActor [weak target] in
            target?.receive(message)
        }
    }
}
