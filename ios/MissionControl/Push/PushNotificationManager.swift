import Foundation
import Security
import UIKit
import UserNotifications

struct NativeInstallationCredentialRecord: Codable, Equatable {
    let credentialId: UUID
    let accessToken: String
    let expiresAt: Date
}

protocol NativeInstallationCredentialStoring: AnyObject {
    func read() throws -> NativeInstallationCredentialRecord?
    func write(_ credential: NativeInstallationCredentialRecord) throws
    func remove() throws
}

final class KeychainNativeInstallationCredentialStore:
    NativeInstallationCredentialStoring
{
    private let service: String
    private let accessGroup: String
    private let account = "installation"

    init(service: String, accessGroup: String) {
        self.service = service
        self.accessGroup = accessGroup
    }

    func read() throws -> NativeInstallationCredentialRecord? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else {
            throw NativePushError.keychain(status)
        }
        return try JSONDecoder().decode(
            NativeInstallationCredentialRecord.self,
            from: data
        )
    }

    func write(_ credential: NativeInstallationCredentialRecord) throws {
        let data = try JSONEncoder().encode(credential)
        var query = baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        query[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(
                baseQuery as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            guard updateStatus == errSecSuccess else {
                throw NativePushError.keychain(updateStatus)
            }
        } else if status != errSecSuccess {
            throw NativePushError.keychain(status)
        }
        guard try read() == credential else {
            throw NativePushError.credentialVerificationFailed
        }
    }

    func remove() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NativePushError.keychain(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: accessGroup,
            kSecAttrSynchronizable as String: false,
        ]
    }
}

protocol NativePushRegistrationStoring: AnyObject {
    var installationId: UUID { get }
    var registrationId: UUID? { get set }
    func removeAll()
}

final class UserDefaultsNativePushRegistrationStore: NativePushRegistrationStoring {
    private let defaults: UserDefaults
    private let installationKey = "native.installation-id"
    private let registrationKey = "native.apns-registration-id"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var installationId: UUID {
        if let value = defaults.string(forKey: installationKey),
           let identifier = UUID(uuidString: value)
        {
            return identifier
        }
        let identifier = UUID()
        defaults.set(identifier.uuidString.lowercased(), forKey: installationKey)
        return identifier
    }

    var registrationId: UUID? {
        get {
            defaults.string(forKey: registrationKey).flatMap(UUID.init(uuidString:))
        }
        set {
            defaults.set(newValue?.uuidString.lowercased(), forKey: registrationKey)
        }
    }

    func removeAll() {
        defaults.removeObject(forKey: installationKey)
        defaults.removeObject(forKey: registrationKey)
    }
}

enum NativePushError: Error {
    case credentialUnavailable
    case credentialExpired
    case credentialVerificationFailed
    case invalidResponse
    case keychain(OSStatus)
    case server(Int)
}

struct NativeAPNsRegistrationResult: Equatable {
    let registrationId: UUID
    let state: String
}

protocol NativePushAPIClientProtocol: AnyObject {
    func register(
        deviceToken: Data,
        credential: NativeInstallationCredentialRecord,
        installationId: UUID
    ) async throws -> NativeAPNsRegistrationResult
    func unregister(
        registrationId: UUID,
        credential: NativeInstallationCredentialRecord,
        installationId: UUID
    ) async throws
    func logout(
        credential: NativeInstallationCredentialRecord,
        installationId: UUID
    ) async throws
}

final class NativePushAPIClient: NativePushAPIClientProtocol {
    private let configuration: AppConfiguration
    private let session: URLSession
    private let bundle: Bundle

    init(
        configuration: AppConfiguration,
        session: URLSession = .shared,
        bundle: Bundle = .main
    ) {
        self.configuration = configuration
        self.session = session
        self.bundle = bundle
    }

    func register(
        deviceToken: Data,
        credential: NativeInstallationCredentialRecord,
        installationId: UUID
    ) async throws -> NativeAPNsRegistrationResult {
        let requestId = UUID()
        let locale = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
        let body = APNsRegistrationRequest(
            version: 1,
            requestId: requestId,
            installationId: installationId,
            deviceToken: Self.hexToken(deviceToken),
            environment: configuration.apnsEnvironment.rawValue,
            topic: configuration.apnsTopic,
            appVersion: bundle.object(
                forInfoDictionaryKey: "CFBundleShortVersionString"
            ) as? String ?? "0.1.0",
            buildNumber: Int(
                bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
            ) ?? 1,
            locale: locale,
            timeZone: TimeZone.current.identifier
        )
        let data = try await send(
            path: "/api/native/push/registrations",
            method: "POST",
            requestId: requestId,
            credential: credential,
            body: body
        )
        let response = try JSONDecoder.nativeAPI.decode(
            APNsRegistrationResponse.self,
            from: data
        )
        guard response.version == 1, response.requestId == requestId, response.ok else {
            throw NativePushError.invalidResponse
        }
        return NativeAPNsRegistrationResult(
            registrationId: response.data.registrationId,
            state: response.data.state
        )
    }

    func unregister(
        registrationId: UUID,
        credential: NativeInstallationCredentialRecord,
        installationId: UUID
    ) async throws {
        let requestId = UUID()
        let body = APNsUnregistrationRequest(
            version: 1,
            requestId: requestId,
            installationId: installationId,
            registrationId: registrationId
        )
        _ = try await send(
            path: "/api/native/push/registrations/\(registrationId.uuidString.lowercased())",
            method: "DELETE",
            requestId: requestId,
            credential: credential,
            body: body
        )
    }

    func logout(
        credential: NativeInstallationCredentialRecord,
        installationId: UUID
    ) async throws {
        let requestId = UUID()
        _ = try await send(
            path: "/api/native/logout",
            method: "POST",
            requestId: requestId,
            credential: credential,
            body: NativeLogoutRequest(
                version: 1,
                requestId: requestId,
                installationId: installationId
            )
        )
    }

    static func hexToken(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    static func authorizationHeader(
        for credential: NativeInstallationCredentialRecord
    ) -> String {
        "Bearer \(credential.accessToken)"
    }

    private func send<Body: Encodable>(
        path: String,
        method: String,
        requestId: UUID,
        credential: NativeInstallationCredentialRecord,
        body: Body
    ) async throws -> Data {
        guard let url = configuration.trustedOrigin.url(path: path) else {
            throw NativePushError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(
            Self.authorizationHeader(for: credential),
            forHTTPHeaderField: "Authorization"
        )
        request.setValue(
            requestId.uuidString.lowercased(),
            forHTTPHeaderField: "Idempotency-Key"
        )
        request.httpBody = try JSONEncoder.nativeAPI.encode(body)
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw NativePushError.invalidResponse
        }
        guard (200 ... 299).contains(response.statusCode) else {
            throw NativePushError.server(response.statusCode)
        }
        return data
    }
}

private struct APNsRegistrationRequest: Encodable {
    let version: Int
    let requestId: UUID
    let installationId: UUID
    let deviceToken: String
    let environment: String
    let topic: String
    let appVersion: String
    let buildNumber: Int
    let locale: String
    let timeZone: String
}

private struct APNsUnregistrationRequest: Encodable {
    let version: Int
    let requestId: UUID
    let installationId: UUID
    let registrationId: UUID
}

private struct NativeLogoutRequest: Encodable {
    let version: Int
    let requestId: UUID
    let installationId: UUID
}

private struct APNsRegistrationResponse: Decodable {
    struct DataPayload: Decodable {
        let registrationId: UUID
        let state: String
        let updatedAt: String
    }

    let version: Int
    let requestId: UUID
    let ok: Bool
    let data: DataPayload
}

private extension JSONEncoder {
    static var nativeAPI: JSONEncoder {
        JSONEncoder()
    }
}

private extension JSONDecoder {
    static var nativeAPI: JSONDecoder {
        JSONDecoder()
    }
}

protocol RemoteNotificationControlling: AnyObject {
    func register()
    func unregister()
}

final class SystemRemoteNotificationController: RemoteNotificationControlling {
    func register() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    func unregister() {
        UIApplication.shared.unregisterForRemoteNotifications()
    }
}

final class NativePushSession {
    private let credentialStore: NativeInstallationCredentialStoring
    private let registrationStore: NativePushRegistrationStoring
    private let client: NativePushAPIClientProtocol
    private let remoteNotifications: RemoteNotificationControlling

    init(
        credentialStore: NativeInstallationCredentialStoring,
        registrationStore: NativePushRegistrationStoring,
        client: NativePushAPIClientProtocol,
        remoteNotifications: RemoteNotificationControlling
    ) {
        self.credentialStore = credentialStore
        self.registrationStore = registrationStore
        self.client = client
        self.remoteNotifications = remoteNotifications
    }

    var authenticationState: NativeAuthenticationState {
        guard let credential = try? credentialStore.read() else {
            return .unauthenticated
        }
        return credential.expiresAt > Date() ? .authenticated : .expired
    }

    func install(_ credential: NativeInstallationCredentialRecord) throws {
        try credentialStore.write(credential)
    }

    func register(deviceToken: Data) async throws -> NativeAPNsRegistrationResult {
        guard let credential = try credentialStore.read() else {
            throw NativePushError.credentialUnavailable
        }
        guard credential.expiresAt > Date() else {
            throw NativePushError.credentialExpired
        }
        let result = try await client.register(
            deviceToken: deviceToken,
            credential: credential,
            installationId: registrationStore.installationId
        )
        registrationStore.registrationId = result.registrationId
        return result
    }

    func logout() async {
        let credential = try? credentialStore.read()
        let installationId = registrationStore.installationId
        if let credential, let registrationId = registrationStore.registrationId {
            try? await client.unregister(
                registrationId: registrationId,
                credential: credential,
                installationId: installationId
            )
        }
        if let credential {
            try? await client.logout(
                credential: credential,
                installationId: installationId
            )
        }
        try? credentialStore.remove()
        registrationStore.removeAll()
        remoteNotifications.unregister()
    }
}

@MainActor
final class PushPermissionGuidancePresenter {
    func showDeniedGuidance() {
        guard let presenter = Self.topViewController() else { return }
        let alert = UIAlertController(
            title: "Notifications are off",
            message: "You can enable Mission Control notifications in iOS Settings.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Not Now", style: .cancel))
        alert.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url)
        })
        presenter.present(alert, animated: true)
    }

    private static func topViewController() -> UIViewController? {
        let root = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController
        var current = root
        while let presented = current?.presentedViewController {
            current = presented
        }
        return current
    }
}

@MainActor
final class PushNotificationManager:
    NSObject,
    NativeAuthenticationStateProviding,
    PushPermissionHandling,
    UNUserNotificationCenterDelegate
{
    static let shared = PushNotificationManager()

    private let notificationCenter = UNUserNotificationCenter.current()
    private let permissionGuidance = PushPermissionGuidancePresenter()
    private var pushSession: NativePushSession?
    private var deepLinkRouter: DeepLinkRouter?
    private weak var eventSender: NativeBridgeEventSending?
    private var openDestination: ((URL) -> Void)?
    private var lastAuthorization: PushAuthorizationState = .notDetermined

    var nativeAuthenticationState: NativeAuthenticationState {
        pushSession?.authenticationState ?? .unauthenticated
    }

    func configure(
        configuration: AppConfiguration,
        eventSender: NativeBridgeEventSending,
        openDestination: @escaping (URL) -> Void
    ) {
        let credentialStore = KeychainNativeInstallationCredentialStore(
            service: configuration.installationKeychainService,
            accessGroup: configuration.installationKeychainAccessGroup
        )
        pushSession = NativePushSession(
            credentialStore: credentialStore,
            registrationStore: UserDefaultsNativePushRegistrationStore(),
            client: NativePushAPIClient(configuration: configuration),
            remoteNotifications: SystemRemoteNotificationController()
        )
        deepLinkRouter = DeepLinkRouter(trustedOrigin: configuration.trustedOrigin)
        self.eventSender = eventSender
        self.openDestination = openDestination
        notificationCenter.delegate = self
    }

    func requestPushAuthorization(
        context _: PushPermissionContext
    ) async throws -> PushAuthorizationState {
        let current = await notificationCenter.notificationSettings()
        if current.authorizationStatus == .denied {
            permissionGuidance.showDeniedGuidance()
            lastAuthorization = .denied
            return .denied
        }
        if current.authorizationStatus == .notDetermined {
            _ = try await notificationCenter.requestAuthorization(
                options: [.alert, .badge, .sound]
            )
        }
        let updated = await notificationCenter.notificationSettings()
        let state = Self.authorizationState(updated.authorizationStatus)
        lastAuthorization = state
        if state == .authorized || state == .provisional {
            UIApplication.shared.registerForRemoteNotifications()
            emitRegistration(state: .registering)
        }
        return state
    }

    func refreshAuthorizationAndRegistration() {
        Task {
            let settings = await notificationCenter.notificationSettings()
            let state = Self.authorizationState(settings.authorizationStatus)
            lastAuthorization = state
            if state == .authorized || state == .provisional {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        emitRegistration(state: .registering)
        Task {
            do {
                guard let pushSession else { throw NativePushError.credentialUnavailable }
                let result = try await pushSession.register(deviceToken: deviceToken)
                eventSender?.pushRegistrationDidChange(
                    authorization: lastAuthorization,
                    state: .registered,
                    registrationId: result.registrationId
                )
            } catch {
                emitRegistration(state: .failed)
            }
        }
    }

    func didFailToRegisterForRemoteNotifications() {
        emitRegistration(state: .failed)
    }

    func logout() {
        Task {
            await pushSession?.logout()
            eventSender?.authenticationDidChange(.unauthenticated)
            emitRegistration(state: .unregistered)
        }
    }

    static func authorizationState(_ status: UNAuthorizationStatus) -> PushAuthorizationState {
        switch status {
        case .notDetermined:
            .notDetermined
        case .denied:
            .denied
        case .authorized, .ephemeral:
            .authorized
        case .provisional:
            .provisional
        @unknown default:
            .denied
        }
    }

    static func notificationURL(userInfo: [AnyHashable: Any]) -> URL? {
        guard let metadata = userInfo["mc"] as? [String: Any],
              metadata["version"] as? Int == 1,
              let value = metadata["deepLink"] as? String
        else {
            return nil
        }
        return URL(string: value)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (
            UNNotificationPresentationOptions
        ) -> Void
    ) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        Task { @MainActor [weak self] in
            defer { completionHandler() }
            guard let self,
                  let incomingURL = Self.notificationURL(userInfo: userInfo),
                  let destination = deepLinkRouter?.destination(for: incomingURL)
            else {
                return
            }
            openDestination?(destination)
        }
    }

    private func emitRegistration(state: PushRegistrationState) {
        eventSender?.pushRegistrationDidChange(
            authorization: lastAuthorization,
            state: state,
            registrationId: nil
        )
    }
}
