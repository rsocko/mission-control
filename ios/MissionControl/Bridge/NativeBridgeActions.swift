import CoreHaptics
import UIKit
import UserNotifications

@MainActor
protocol NativeAuthenticationStateProviding: AnyObject {
    var nativeAuthenticationState: NativeAuthenticationState { get }
}

@MainActor
final class UnauthenticatedNativeStateProvider: NativeAuthenticationStateProviding {
    let nativeAuthenticationState: NativeAuthenticationState = .unauthenticated
}

@MainActor
protocol NativeBridgeActionHandling: AnyObject {
    func handle(_ request: NativeBridgeRequest) async -> Result<NativeBridgeResult, NativeBridgeError>
    func tearDown()
}

extension NativeBridgeActionHandling {
    func tearDown() {}
}

@MainActor
protocol PushPermissionHandling: AnyObject {
    func requestPushAuthorization(
        context: PushPermissionContext
    ) async throws -> PushAuthorizationState
}

enum NativeHapticPattern: Equatable {
    case success
    case warning
    case lightImpact(Double)
    case mediumImpact(Double)
    case softTick(Double)
    case celebration

    static func resolve(_ payload: HapticFeedbackPayload) -> NativeHapticPattern {
        switch payload.type {
        case .success:
            payload.intensity == 1 ? .celebration : .success
        case .warning:
            .warning
        case .selection:
            .softTick(payload.intensity ?? 0.3)
        case .impact:
            if let intensity = payload.intensity, intensity < 0.5 {
                .lightImpact(intensity)
            } else {
                .mediumImpact(payload.intensity ?? 1)
            }
        }
    }
}

@MainActor
protocol NativeHapticDriving: AnyObject {
    func deliver(_ pattern: NativeHapticPattern) -> Bool
    func stop()
}

@MainActor
protocol HapticFeedbackProviding: AnyObject {
    func deliver(_ payload: HapticFeedbackPayload) -> Bool
    func stop()
}

@MainActor
final class AccessibleHapticFeedbackProvider: HapticFeedbackProviding {
    private let driver: NativeHapticDriving
    private let isReduceMotionEnabled: () -> Bool

    init(
        driver: NativeHapticDriving? = nil,
        isReduceMotionEnabled: @escaping () -> Bool = { UIAccessibility.isReduceMotionEnabled }
    ) {
        self.driver = driver ?? SystemNativeHapticDriver()
        self.isReduceMotionEnabled = isReduceMotionEnabled
    }

    func deliver(_ payload: HapticFeedbackPayload) -> Bool {
        guard !isReduceMotionEnabled() else { return false }
        return driver.deliver(NativeHapticPattern.resolve(payload))
    }

    func stop() {
        driver.stop()
    }
}

@MainActor
final class SystemNativeHapticDriver: NativeHapticDriving {
    private var engine: CHHapticEngine?
    private var engineGeneration = 0
    private var player: CHHapticPatternPlayer?

    func deliver(_ pattern: NativeHapticPattern) -> Bool {
        switch pattern {
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case let .lightImpact(intensity):
            UIImpactFeedbackGenerator(style: .light)
                .impactOccurred(intensity: CGFloat(intensity))
        case let .mediumImpact(intensity):
            return deliverMediumImpact(intensity: intensity)
        case let .softTick(intensity):
            UIImpactFeedbackGenerator(style: .soft)
                .impactOccurred(intensity: CGFloat(intensity))
        case .celebration:
            return deliverCelebration()
        }
        return true
    }

    func stop() {
        engineGeneration += 1
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
        engine?.stop(completionHandler: nil)
        engine = nil
    }

    private func deliverMediumImpact(intensity: Double) -> Bool {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            UIImpactFeedbackGenerator(style: .medium)
                .impactOccurred(intensity: CGFloat(intensity))
            return true
        }

        do {
            let engine = try resolvedEngine()
            let event = CHHapticEvent(
                eventType: .hapticContinuous,
                parameters: [
                    CHHapticEventParameter(
                        parameterID: .hapticIntensity,
                        value: Float(intensity * 0.45)
                    ),
                    CHHapticEventParameter(
                        parameterID: .hapticSharpness,
                        value: 0.4
                    ),
                ],
                relativeTime: 0,
                duration: 0.08
            )
            let ramp = CHHapticParameterCurve(
                parameterID: .hapticIntensityControl,
                controlPoints: [
                    .init(relativeTime: 0, value: 0.25),
                    .init(relativeTime: 0.08, value: Float(intensity)),
                ],
                relativeTime: 0
            )
            let pattern = try CHHapticPattern(events: [event], parameterCurves: [ramp])
            try engine.start()
            try start(pattern: pattern, on: engine)
            return true
        } catch {
            stop()
            UIImpactFeedbackGenerator(style: .medium)
                .impactOccurred(intensity: CGFloat(intensity))
            return true
        }
    }

    private func deliverCelebration() -> Bool {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return true
        }

        do {
            let engine = try resolvedEngine()
            let events = [
                celebrationEvent(intensity: 0.35, sharpness: 0.25, time: 0),
                celebrationEvent(intensity: 0.55, sharpness: 0.35, time: 0.11),
                celebrationEvent(intensity: 0.8, sharpness: 0.45, time: 0.22),
            ]
            let pattern = try CHHapticPattern(events: events, parameters: [])
            try engine.start()
            try start(pattern: pattern, on: engine)
            return true
        } catch {
            stop()
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            return true
        }
    }

    private func resolvedEngine() throws -> CHHapticEngine {
        if let engine { return engine }
        let engine = try CHHapticEngine()
        engineGeneration += 1
        let generation = engineGeneration
        engine.isAutoShutdownEnabled = true
        engine.resetHandler = { [weak self] in
            Task { @MainActor [weak self] in
                guard self?.engineGeneration == generation else { return }
                self?.engine = nil
                self?.player = nil
            }
        }
        engine.stoppedHandler = { [weak self] _ in
            Task { @MainActor [weak self] in
                guard self?.engineGeneration == generation else { return }
                self?.engine = nil
                self?.player = nil
            }
        }
        self.engine = engine
        return engine
    }

    private func start(pattern: CHHapticPattern, on engine: CHHapticEngine) throws {
        try? player?.stop(atTime: CHHapticTimeImmediate)
        let player = try engine.makePlayer(with: pattern)
        self.player = player
        try player.start(atTime: CHHapticTimeImmediate)
    }

    private func celebrationEvent(
        intensity: Float,
        sharpness: Float,
        time: TimeInterval
    ) -> CHHapticEvent {
        CHHapticEvent(
            eventType: .hapticTransient,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: sharpness),
            ],
            relativeTime: time
        )
    }
}

@MainActor
final class SystemNativeBridgeActionHandler: NativeBridgeActionHandling {
    private let authenticationStateProvider: NativeAuthenticationStateProviding
    private let bundle: Bundle
    private let pushPermissionHandler: PushPermissionHandling
    private let hapticFeedbackProvider: HapticFeedbackProviding

    init(
        authenticationStateProvider: NativeAuthenticationStateProviding? = nil,
        bundle: Bundle = .main,
        pushPermissionHandler: PushPermissionHandling? = nil,
        hapticFeedbackProvider: HapticFeedbackProviding? = nil
    ) {
        self.authenticationStateProvider =
            authenticationStateProvider ?? UnauthenticatedNativeStateProvider()
        self.bundle = bundle
        self.pushPermissionHandler = pushPermissionHandler
            ?? PushNotificationManager.shared
        self.hapticFeedbackProvider = hapticFeedbackProvider
            ?? AccessibleHapticFeedbackProvider()
    }

    func handle(
        _ request: NativeBridgeRequest
    ) async -> Result<NativeBridgeResult, NativeBridgeError> {
        switch request.payload {
        case .bootstrap:
            .success(.bootstrap(bootstrapResult()))
        case let .requestPushPermission(payload):
            await requestPushPermission(context: payload.context)
        case let .hapticFeedback(payload):
            .success(
                .hapticFeedback(
                    HapticFeedbackResult(delivered: hapticFeedbackProvider.deliver(payload))
                )
            )
        case let .openURL(payload):
            await openURL(payload.url)
        case let .setBadge(payload):
            await setBadge(payload.count)
        }
    }

    private func bootstrapResult() -> BootstrapResult {
        let rawVersion = bundle.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String
        let version = rawVersion.flatMap {
            $0.isEmpty ? nil : String($0.unicodeScalars.prefix(64))
        } ?? "0.1.0"
        let rawBuild = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        let buildNumber = max(Int(rawBuild ?? "") ?? 1, 1)
        return BootstrapResult(
            appVersion: version,
            buildNumber: buildNumber,
            authentication: authenticationStateProvider.nativeAuthenticationState,
            capabilities: NativeBridgeCapability.allCases
        )
    }

    private func requestPushPermission(
        context: PushPermissionContext
    ) async -> Result<NativeBridgeResult, NativeBridgeError> {
        do {
            let authorization = try await pushPermissionHandler.requestPushAuthorization(
                context: context
            )
            return .success(
                .requestPushPermission(
                    PushPermissionResult(authorization: authorization)
                )
            )
        } catch {
            return .failure(
                NativeBridgeError(
                    code: .nativeFailure,
                    message: "Notification permission could not be requested",
                    retryable: true
                )
            )
        }
    }

    private func openURL(_ url: URL) async -> Result<NativeBridgeResult, NativeBridgeError> {
        guard NavigationPolicy.isSafeExternalURL(url) else {
            return .failure(
                NativeBridgeError(
                    code: .invalidNavigation,
                    message: "The URL is not allowed",
                    retryable: false
                )
            )
        }
        let opened = await UIApplication.shared.open(url)
        return .success(.openURL(OpenURLResult(opened: opened)))
    }

    private func setBadge(_ count: Int) async -> Result<NativeBridgeResult, NativeBridgeError> {
        do {
            try await UNUserNotificationCenter.current().setBadgeCount(count)
            return .success(.setBadge(SetBadgeResult(count: count)))
        } catch {
            return .failure(
                NativeBridgeError(
                    code: .nativeFailure,
                    message: "The application badge could not be updated",
                    retryable: true
                )
            )
        }
    }

    func tearDown() {
        hapticFeedbackProvider.stop()
    }
}
