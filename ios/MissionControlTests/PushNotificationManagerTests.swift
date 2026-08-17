import XCTest
import UserNotifications
@testable import MissionControl

@MainActor
final class PushNotificationManagerTests: XCTestCase {
    func testMapsEveryAuthorizationStateWithoutElevatingUnknownValues() {
        XCTAssertEqual(
            PushNotificationManager.authorizationState(.notDetermined),
            .notDetermined
        )
        XCTAssertEqual(PushNotificationManager.authorizationState(.denied), .denied)
        XCTAssertEqual(
            PushNotificationManager.authorizationState(.provisional),
            .provisional
        )
        XCTAssertEqual(
            PushNotificationManager.authorizationState(.authorized),
            .authorized
        )
        XCTAssertEqual(
            PushNotificationManager.authorizationState(.ephemeral),
            .authorized
        )
    }

    func testDeviceTokenHexEncodingIsStableAndLowercase() {
        XCTAssertEqual(
            NativePushAPIClient.hexToken(Data([0x00, 0x0A, 0xFF, 0x10])),
            "000aff10"
        )
    }

    func testInstallationCredentialBuildsBearerAuthorizationHeader() {
        XCTAssertEqual(
            NativePushAPIClient.authorizationHeader(for: credential()),
            "Bearer native-secret-that-never-crosses-webkit"
        )
    }

    func testNotificationTapMetadataRequiresVersionedNativeDeepLink() throws {
        let valid: [AnyHashable: Any] = [
            "mc": [
                "version": 1,
                "deepLink": "mc://view/triage",
                "notificationId": "redacted-id",
            ],
        ]
        let incoming = try XCTUnwrap(
            PushNotificationManager.notificationURL(userInfo: valid)
        )
        let router = DeepLinkRouter(
            trustedOrigin: try TrustedOrigin("https://mc.example.com")
        )
        XCTAssertEqual(
            router.destination(for: incoming)?.absoluteString,
            "https://mc.example.com/triage"
        )
        XCTAssertNil(
            PushNotificationManager.notificationURL(
                userInfo: ["mc": ["version": 2, "deepLink": "mc://view/today"]]
            )
        )
        XCTAssertNil(
            PushNotificationManager.notificationURL(
                userInfo: ["deviceToken": "must-not-be-consumed"]
            )
        )
    }

    func testRegistrationKeepsTokenNativeAndPersistsOnlyOpaqueRegistrationID() async throws {
        let credential = credential()
        let credentialStore = MemoryCredentialStore(credential: credential)
        let registrationStore = MemoryRegistrationStore()
        let client = RecordingPushClient()
        let remote = RecordingRemoteNotifications()
        let session = NativePushSession(
            credentialStore: credentialStore,
            registrationStore: registrationStore,
            client: client,
            remoteNotifications: remote
        )
        let token = Data(repeating: 0xAB, count: 32)

        let result = try await session.register(deviceToken: token)

        XCTAssertEqual(client.registeredToken, token)
        XCTAssertEqual(registrationStore.registrationId, result.registrationId)
        XCTAssertEqual(registrationStore.persistedValues, [
            registrationStore.installationId.uuidString.lowercased(),
            result.registrationId.uuidString.lowercased(),
        ])
        XCTAssertFalse(registrationStore.persistedValues.contains(NativePushAPIClient.hexToken(token)))
    }

    func testLogoutAlwaysClearsLocalStateAndUnregistersAfterNetworkFailure() async {
        let credentialStore = MemoryCredentialStore(credential: credential())
        let registrationStore = MemoryRegistrationStore()
        registrationStore.registrationId = UUID(
            uuidString: "c83d74ec-d4a1-45f7-8153-79fdb63cafb9"
        )
        let client = RecordingPushClient()
        client.shouldFail = true
        let remote = RecordingRemoteNotifications()
        let session = NativePushSession(
            credentialStore: credentialStore,
            registrationStore: registrationStore,
            client: client,
            remoteNotifications: remote
        )

        await session.logout()

        XCTAssertTrue(client.unregisterCalled)
        XCTAssertTrue(client.logoutCalled)
        XCTAssertNil(credentialStore.credential)
        XCTAssertNil(registrationStore.registrationId)
        XCTAssertTrue(registrationStore.didRemoveAll)
        XCTAssertTrue(remote.didUnregister)
    }

    private func credential() -> NativeInstallationCredentialRecord {
        NativeInstallationCredentialRecord(
            credentialId: UUID(uuidString: "83c45840-a47f-4269-aae9-5a3f4fbd220b")!,
            accessToken: "native-secret-that-never-crosses-webkit",
            expiresAt: Date().addingTimeInterval(3_600)
        )
    }
}

private final class MemoryCredentialStore: NativeInstallationCredentialStoring {
    var credential: NativeInstallationCredentialRecord?

    init(credential: NativeInstallationCredentialRecord?) {
        self.credential = credential
    }

    func read() throws -> NativeInstallationCredentialRecord? {
        credential
    }

    func write(_ credential: NativeInstallationCredentialRecord) throws {
        self.credential = credential
    }

    func remove() throws {
        credential = nil
    }
}

private final class MemoryRegistrationStore: NativePushRegistrationStoring {
    let installationId = UUID(uuidString: "570ce945-1433-40f3-92c6-af7c14343acd")!
    var registrationId: UUID?
    var didRemoveAll = false

    var persistedValues: [String] {
        [
            installationId.uuidString.lowercased(),
            registrationId?.uuidString.lowercased() ?? "",
        ]
    }

    func removeAll() {
        registrationId = nil
        didRemoveAll = true
    }
}

private final class RecordingPushClient: NativePushAPIClientProtocol {
    let returnedRegistrationId = UUID(
        uuidString: "c83d74ec-d4a1-45f7-8153-79fdb63cafb9"
    )!
    var registeredToken: Data?
    var unregisterCalled = false
    var logoutCalled = false
    var shouldFail = false

    func register(
        deviceToken: Data,
        credential: NativeInstallationCredentialRecord,
        installationId: UUID
    ) async throws -> NativeAPNsRegistrationResult {
        registeredToken = deviceToken
        if shouldFail { throw NativePushError.server(503) }
        return NativeAPNsRegistrationResult(
            registrationId: returnedRegistrationId,
            state: "registered"
        )
    }

    func unregister(
        registrationId: UUID,
        credential: NativeInstallationCredentialRecord,
        installationId: UUID
    ) async throws {
        unregisterCalled = true
        if shouldFail { throw NativePushError.server(503) }
    }

    func logout(
        credential: NativeInstallationCredentialRecord,
        installationId: UUID
    ) async throws {
        logoutCalled = true
        if shouldFail { throw NativePushError.server(503) }
    }
}

private final class RecordingRemoteNotifications: RemoteNotificationControlling {
    var didRegister = false
    var didUnregister = false

    func register() {
        didRegister = true
    }

    func unregister() {
        didUnregister = true
    }
}
