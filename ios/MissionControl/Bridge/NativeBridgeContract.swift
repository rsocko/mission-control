import Foundation

enum NativeBridgeAction: String, Codable, CaseIterable, Sendable {
    case bootstrap
    case requestPushPermission
    case hapticFeedback
    case openURL
    case setBadge
}

enum NativeBridgeCapability: String, Codable, CaseIterable, Sendable {
    case badge
    case externalLinks
    case haptics
    case push
    case shareCaptureStatus
}

enum NativeAuthenticationState: String, Codable, Sendable {
    case authenticated
    case unauthenticated
    case expired
}

enum PushAuthorizationState: String, Codable, Sendable {
    case notDetermined
    case denied
    case authorized
    case provisional
}

enum PushPermissionContext: String, Codable, Sendable {
    case onboarding
    case notifications
    case settings
}

enum HapticFeedbackType: String, Codable, Sendable {
    case success
    case impact
    case warning
    case selection
}

struct BootstrapPayload: Codable, Equatable, Sendable {
    let webClientVersion: String
}

struct PushPermissionPayload: Codable, Equatable, Sendable {
    let context: PushPermissionContext
}

struct HapticFeedbackPayload: Codable, Equatable, Sendable {
    let type: HapticFeedbackType
    let intensity: Double?
}

struct OpenURLPayload: Codable, Equatable, Sendable {
    let url: URL
}

struct SetBadgePayload: Codable, Equatable, Sendable {
    let count: Int
}

enum NativeBridgeRequestPayload: Equatable, Sendable {
    case bootstrap(BootstrapPayload)
    case requestPushPermission(PushPermissionPayload)
    case hapticFeedback(HapticFeedbackPayload)
    case openURL(OpenURLPayload)
    case setBadge(SetBadgePayload)
}

struct NativeBridgeRequest: Codable, Equatable, Sendable {
    static let version = 1

    let requestId: UUID
    let action: NativeBridgeAction
    let payload: NativeBridgeRequestPayload

    init(requestId: UUID, payload: NativeBridgeRequestPayload) {
        self.requestId = requestId
        self.payload = payload
        switch payload {
        case .bootstrap:
            action = .bootstrap
        case .requestPushPermission:
            action = .requestPushPermission
        case .hapticFeedback:
            action = .hapticFeedback
        case .openURL:
            action = .openURL
        case .setBadge:
            action = .setBadge
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.closedContainer(
            allowing: ["version", "requestId", "action", "payload"]
        )
        let version = try container.decode(Int.self, for: "version")
        guard version == Self.version else {
            throw NativeBridgeDecodingError.unsupportedVersion(version)
        }

        requestId = try container.decodeBridgeUUID(for: "requestId")
        let actionValue = try container.decode(String.self, for: "action")
        guard let decodedAction = NativeBridgeAction(rawValue: actionValue) else {
            throw NativeBridgeDecodingError.unsupportedAction(actionValue)
        }
        action = decodedAction

        let payloadDecoder = try container.superDecoder(for: "payload")
        switch decodedAction {
        case .bootstrap:
            let payloadContainer = try payloadDecoder.closedContainer(
                allowing: ["webClientVersion"]
            )
            let value = try payloadContainer.decode(String.self, for: "webClientVersion")
            guard value.isBridgeNonBlank(maxCodePoints: 64) else {
                throw NativeBridgeDecodingError.invalidMessage
            }
            payload = .bootstrap(BootstrapPayload(webClientVersion: value))
        case .requestPushPermission:
            let payloadContainer = try payloadDecoder.closedContainer(allowing: ["context"])
            payload = .requestPushPermission(
                PushPermissionPayload(
                    context: try payloadContainer.decode(PushPermissionContext.self, for: "context")
                )
            )
        case .hapticFeedback:
            let payloadContainer = try payloadDecoder.closedContainer(
                allowing: ["type", "intensity"],
                requiring: ["type"]
            )
            let intensity = try payloadContainer.decodeIfPresent(Double.self, for: "intensity")
            guard intensity.map({ $0.isFinite && (0 ... 1).contains($0) }) ?? true else {
                throw NativeBridgeDecodingError.invalidMessage
            }
            payload = .hapticFeedback(
                HapticFeedbackPayload(
                    type: try payloadContainer.decode(HapticFeedbackType.self, for: "type"),
                    intensity: intensity
                )
            )
        case .openURL:
            let payloadContainer = try payloadDecoder.closedContainer(allowing: ["url"])
            let value = try payloadContainer.decode(String.self, for: "url")
            guard value.unicodeScalars.count <= 2_048,
                  let url = URL(string: value),
                  NavigationPolicy.isSafeExternalURL(url)
            else {
                throw NativeBridgeDecodingError.invalidMessage
            }
            payload = .openURL(OpenURLPayload(url: url))
        case .setBadge:
            let payloadContainer = try payloadDecoder.closedContainer(allowing: ["count"])
            let count = try payloadContainer.decode(Int.self, for: "count")
            guard (0 ... 999).contains(count) else {
                throw NativeBridgeDecodingError.invalidMessage
            }
            payload = .setBadge(SetBadgePayload(count: count))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)
        try container.encode(Self.version, for: "version")
        try container.encode(requestId, for: "requestId")
        try container.encode(action.rawValue, for: "action")
        let payloadEncoder = container.superEncoder(forKey: AnyCodingKey("payload"))
        switch payload {
        case let .bootstrap(value):
            try value.encode(to: payloadEncoder)
        case let .requestPushPermission(value):
            try value.encode(to: payloadEncoder)
        case let .hapticFeedback(value):
            try value.encode(to: payloadEncoder)
        case let .openURL(value):
            try value.encode(to: payloadEncoder)
        case let .setBadge(value):
            try value.encode(to: payloadEncoder)
        }
    }
}

struct BootstrapResult: Codable, Equatable, Sendable {
    let appVersion: String
    let buildNumber: Int
    let authentication: NativeAuthenticationState
    let capabilities: [NativeBridgeCapability]
}

struct PushPermissionResult: Codable, Equatable, Sendable {
    let authorization: PushAuthorizationState
}

struct HapticFeedbackResult: Codable, Equatable, Sendable {
    let delivered: Bool
}

struct OpenURLResult: Codable, Equatable, Sendable {
    let opened: Bool
}

struct SetBadgeResult: Codable, Equatable, Sendable {
    let count: Int
}

enum NativeBridgeResult: Equatable, Sendable {
    case bootstrap(BootstrapResult)
    case requestPushPermission(PushPermissionResult)
    case hapticFeedback(HapticFeedbackResult)
    case openURL(OpenURLResult)
    case setBadge(SetBadgeResult)

    var action: NativeBridgeAction {
        switch self {
        case .bootstrap: .bootstrap
        case .requestPushPermission: .requestPushPermission
        case .hapticFeedback: .hapticFeedback
        case .openURL: .openURL
        case .setBadge: .setBadge
        }
    }
}

enum NativeBridgeErrorCode: String, Codable, Sendable {
    case invalidMessage = "INVALID_MESSAGE"
    case unsupportedVersion = "UNSUPPORTED_VERSION"
    case unsupportedAction = "UNSUPPORTED_ACTION"
    case untrustedOrigin = "UNTRUSTED_ORIGIN"
    case invalidNavigation = "INVALID_NAVIGATION"
    case notAuthenticated = "NOT_AUTHENTICATED"
    case permissionDenied = "PERMISSION_DENIED"
    case timeout = "TIMEOUT"
    case nativeFailure = "NATIVE_FAILURE"
}

struct NativeBridgeError: Codable, Error, Equatable, Sendable {
    let code: NativeBridgeErrorCode
    let message: String
    let retryable: Bool

    init(code: NativeBridgeErrorCode, message: String, retryable: Bool) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.closedContainer(
            allowing: ["code", "message", "retryable"]
        )
        code = try container.decode(NativeBridgeErrorCode.self, for: "code")
        message = try container.decode(String.self, for: "message")
        retryable = try container.decode(Bool.self, for: "retryable")
        guard message.isBridgeNonBlank(maxCodePoints: 512) else {
            throw NativeBridgeDecodingError.invalidMessage
        }
    }
}

enum NativeBridgeResponse: Codable, Equatable, Sendable {
    case success(requestId: UUID, result: NativeBridgeResult)
    case failure(requestId: UUID, action: String, error: NativeBridgeError)

    init(from decoder: Decoder) throws {
        let unchecked = try decoder.container(keyedBy: AnyCodingKey.self)
        let ok = try unchecked.decode(Bool.self, forKey: AnyCodingKey("ok"))
        let allowed = ok
            ? ["version", "requestId", "action", "ok", "result"]
            : ["version", "requestId", "action", "ok", "error"]
        let container = try decoder.closedContainer(allowing: Set(allowed))
        let version = try container.decode(Int.self, for: "version")
        guard version == NativeBridgeRequest.version else {
            throw NativeBridgeDecodingError.unsupportedVersion(version)
        }
        let requestId = try container.decodeBridgeUUID(for: "requestId")
        let actionValue = try container.decode(String.self, for: "action")

        if ok {
            guard let action = NativeBridgeAction(rawValue: actionValue) else {
                throw NativeBridgeDecodingError.unsupportedAction(actionValue)
            }
            let resultDecoder = try container.superDecoder(for: "result")
            let result = try Self.decodeResult(action: action, from: resultDecoder)
            self = .success(requestId: requestId, result: result)
        } else {
            guard actionValue.isBridgeNonBlank(maxCodePoints: 128) else {
                throw NativeBridgeDecodingError.invalidMessage
            }
            self = .failure(
                requestId: requestId,
                action: actionValue,
                error: try container.decode(NativeBridgeError.self, for: "error")
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)
        try container.encode(NativeBridgeRequest.version, for: "version")
        switch self {
        case let .success(requestId, result):
            try container.encode(requestId, for: "requestId")
            try container.encode(result.action.rawValue, for: "action")
            try container.encode(true, for: "ok")
            let resultEncoder = container.superEncoder(forKey: AnyCodingKey("result"))
            switch result {
            case let .bootstrap(value):
                try value.encode(to: resultEncoder)
            case let .requestPushPermission(value):
                try value.encode(to: resultEncoder)
            case let .hapticFeedback(value):
                try value.encode(to: resultEncoder)
            case let .openURL(value):
                try value.encode(to: resultEncoder)
            case let .setBadge(value):
                try value.encode(to: resultEncoder)
            }
        case let .failure(requestId, action, error):
            try container.encode(requestId, for: "requestId")
            try container.encode(action, for: "action")
            try container.encode(false, for: "ok")
            try container.encode(error, for: "error")
        }
    }

    private static func decodeResult(
        action: NativeBridgeAction,
        from decoder: Decoder
    ) throws -> NativeBridgeResult {
        switch action {
        case .bootstrap:
            let container = try decoder.closedContainer(
                allowing: ["appVersion", "buildNumber", "authentication", "capabilities"]
            )
            let appVersion = try container.decode(String.self, for: "appVersion")
            let buildNumber = try container.decode(Int.self, for: "buildNumber")
            let capabilities = try container.decode(
                [NativeBridgeCapability].self,
                for: "capabilities"
            )
            guard appVersion.isBridgeNonBlank(maxCodePoints: 64),
                  buildNumber > 0,
                  capabilities.count <= NativeBridgeCapability.allCases.count,
                  Set(capabilities.map(\.rawValue)).count == capabilities.count
            else {
                throw NativeBridgeDecodingError.invalidMessage
            }
            return .bootstrap(
                BootstrapResult(
                    appVersion: appVersion,
                    buildNumber: buildNumber,
                    authentication: try container.decode(
                        NativeAuthenticationState.self,
                        for: "authentication"
                    ),
                    capabilities: capabilities
                )
            )
        case .requestPushPermission:
            let container = try decoder.closedContainer(allowing: ["authorization"])
            return .requestPushPermission(
                PushPermissionResult(
                    authorization: try container.decode(
                        PushAuthorizationState.self,
                        for: "authorization"
                    )
                )
            )
        case .hapticFeedback:
            let container = try decoder.closedContainer(allowing: ["delivered"])
            return .hapticFeedback(
                HapticFeedbackResult(delivered: try container.decode(Bool.self, for: "delivered"))
            )
        case .openURL:
            let container = try decoder.closedContainer(allowing: ["opened"])
            return .openURL(
                OpenURLResult(opened: try container.decode(Bool.self, for: "opened"))
            )
        case .setBadge:
            let container = try decoder.closedContainer(allowing: ["count"])
            let count = try container.decode(Int.self, for: "count")
            guard (0 ... 999).contains(count) else {
                throw NativeBridgeDecodingError.invalidMessage
            }
            return .setBadge(SetBadgeResult(count: count))
        }
    }
}

enum NativeBridgeEventAction: String, Codable, CaseIterable, Sendable {
    case authenticationChanged
    case networkStatus
    case pushRegistrationChanged
    case shareCaptureCompleted
}

enum PushRegistrationState: String, Codable, Sendable {
    case unregistered
    case registering
    case registered
    case failed
}

enum ShareCaptureStatus: String, Codable, Sendable {
    case created
    case duplicate
}

enum NativeBridgeEventPayload: Equatable, Sendable {
    case authenticationChanged(NativeAuthenticationState)
    case networkStatus(NetworkStatus)
    case pushRegistrationChanged(
        authorization: PushAuthorizationState,
        state: PushRegistrationState,
        registrationId: UUID?
    )
    case shareCaptureCompleted(captureRequestId: UUID, status: ShareCaptureStatus, itemId: String)

    var action: NativeBridgeEventAction {
        switch self {
        case .authenticationChanged: .authenticationChanged
        case .networkStatus: .networkStatus
        case .pushRegistrationChanged: .pushRegistrationChanged
        case .shareCaptureCompleted: .shareCaptureCompleted
        }
    }
}

struct NativeBridgeEvent: Codable, Equatable, Sendable {
    let requestId: UUID
    let payload: NativeBridgeEventPayload

    init(requestId: UUID = UUID(), payload: NativeBridgeEventPayload) {
        self.requestId = requestId
        self.payload = payload
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.closedContainer(
            allowing: ["version", "requestId", "action", "payload"]
        )
        let version = try container.decode(Int.self, for: "version")
        guard version == NativeBridgeRequest.version else {
            throw NativeBridgeDecodingError.unsupportedVersion(version)
        }
        requestId = try container.decodeBridgeUUID(for: "requestId")
        let action = try container.decode(NativeBridgeEventAction.self, for: "action")
        let payloadDecoder = try container.superDecoder(for: "payload")
        switch action {
        case .authenticationChanged:
            let nested = try payloadDecoder.closedContainer(allowing: ["state"])
            payload = .authenticationChanged(
                try nested.decode(NativeAuthenticationState.self, for: "state")
            )
        case .networkStatus:
            let nested = try payloadDecoder.closedContainer(allowing: ["status"])
            payload = .networkStatus(try nested.decode(NetworkStatus.self, for: "status"))
        case .pushRegistrationChanged:
            let nested = try payloadDecoder.closedContainer(
                allowing: ["authorization", "state", "registrationId"],
                requiring: ["authorization", "state"]
            )
            let state = try nested.decode(PushRegistrationState.self, for: "state")
            let registrationId = try nested.decodeBridgeUUIDIfPresent(for: "registrationId")
            guard (state == .registered) == (registrationId != nil) else {
                throw NativeBridgeDecodingError.invalidMessage
            }
            payload = .pushRegistrationChanged(
                authorization: try nested.decode(
                    PushAuthorizationState.self,
                    for: "authorization"
                ),
                state: state,
                registrationId: registrationId
            )
        case .shareCaptureCompleted:
            let nested = try payloadDecoder.closedContainer(
                allowing: ["captureRequestId", "status", "itemId"]
            )
            let itemId = try nested.decode(String.self, for: "itemId")
            guard itemId.isBridgeNonBlank(maxCodePoints: 128) else {
                throw NativeBridgeDecodingError.invalidMessage
            }
            payload = .shareCaptureCompleted(
                captureRequestId: try nested.decodeBridgeUUID(for: "captureRequestId"),
                status: try nested.decode(ShareCaptureStatus.self, for: "status"),
                itemId: itemId
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)
        try container.encode(NativeBridgeRequest.version, for: "version")
        try container.encode(requestId, for: "requestId")
        try container.encode(payload.action.rawValue, for: "action")
        var nested = container.nestedContainer(
            keyedBy: AnyCodingKey.self,
            forKey: AnyCodingKey("payload")
        )
        switch payload {
        case let .authenticationChanged(state):
            try nested.encode(state, for: "state")
        case let .networkStatus(status):
            try nested.encode(status, for: "status")
        case let .pushRegistrationChanged(authorization, state, registrationId):
            try nested.encode(authorization, for: "authorization")
            try nested.encode(state, for: "state")
            try nested.encodeIfPresent(registrationId, for: "registrationId")
        case let .shareCaptureCompleted(captureRequestId, status, itemId):
            try nested.encode(captureRequestId, for: "captureRequestId")
            try nested.encode(status, for: "status")
            try nested.encode(itemId, for: "itemId")
        }
    }
}

enum NativeBridgeDecodingError: Error, Equatable {
    case invalidMessage
    case unsupportedVersion(Int)
    case unsupportedAction(String)
    case messageTooLarge
}

enum NativeBridgeUUID {
    static func parse(_ value: String) -> UUID? {
        let characters = Array(value.lowercased())
        guard characters.count == 36,
              characters[8] == "-",
              characters[13] == "-",
              characters[18] == "-",
              characters[23] == "-",
              ("1" ... "8").contains(String(characters[14])),
              ["8", "9", "a", "b"].contains(String(characters[19]))
        else {
            return nil
        }

        let hexadecimal = CharacterSet(charactersIn: "0123456789abcdef")
        guard characters.enumerated().allSatisfy({ index, character in
            [8, 13, 18, 23].contains(index)
                || character.unicodeScalars.allSatisfy(hexadecimal.contains)
        }) else {
            return nil
        }
        return UUID(uuidString: value)
    }
}

enum NativeBridgeCodec {
    static let maximumMessageBytes = 64 * 1_024

    static func decodeRequest(from body: Any) throws -> NativeBridgeRequest {
        try JSONDecoder().decode(NativeBridgeRequest.self, from: data(from: body))
    }

    static func decodeResponse(from body: Any) throws -> NativeBridgeResponse {
        try JSONDecoder().decode(NativeBridgeResponse.self, from: data(from: body))
    }

    static func decodeEvent(from body: Any) throws -> NativeBridgeEvent {
        try JSONDecoder().decode(NativeBridgeEvent.self, from: data(from: body))
    }

    static func jsonObject<Value: Encodable>(for value: Value) throws -> Any {
        let data = try JSONEncoder().encode(value)
        guard data.count <= maximumMessageBytes else {
            throw NativeBridgeDecodingError.messageTooLarge
        }
        return try JSONSerialization.jsonObject(with: data)
    }

    private static func data(from body: Any) throws -> Data {
        guard JSONSerialization.isValidJSONObject(body) else {
            throw NativeBridgeDecodingError.invalidMessage
        }
        let data = try JSONSerialization.data(withJSONObject: body)
        guard data.count <= maximumMessageBytes else {
            throw NativeBridgeDecodingError.messageTooLarge
        }
        return data
    }
}

private struct AnyCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int?

    init(_ stringValue: String) {
        self.stringValue = stringValue
        intValue = nil
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

private extension Decoder {
    func closedContainer(
        allowing allowedKeys: Set<String>,
        requiring requiredKeys: Set<String>? = nil
    ) throws -> KeyedDecodingContainer<AnyCodingKey> {
        let container = try self.container(keyedBy: AnyCodingKey.self)
        let actualKeys = Set(container.allKeys.map(\.stringValue))
        let requiredKeys = requiredKeys ?? allowedKeys
        guard actualKeys.isSubset(of: allowedKeys),
              requiredKeys.isSubset(of: actualKeys)
        else {
            throw NativeBridgeDecodingError.invalidMessage
        }
        return container
    }
}

private extension KeyedDecodingContainer where Key == AnyCodingKey {
    func decode<Value: Decodable>(_ type: Value.Type, for key: String) throws -> Value {
        try decode(type, forKey: AnyCodingKey(key))
    }

    func decodeIfPresent<Value: Decodable>(
        _ type: Value.Type,
        for key: String
    ) throws -> Value? {
        try decodeIfPresent(type, forKey: AnyCodingKey(key))
    }

    func superDecoder(for key: String) throws -> Decoder {
        try superDecoder(forKey: AnyCodingKey(key))
    }

    func decodeBridgeUUID(for key: String) throws -> UUID {
        let value = try decode(String.self, for: key)
        guard let uuid = NativeBridgeUUID.parse(value) else {
            throw NativeBridgeDecodingError.invalidMessage
        }
        return uuid
    }

    func decodeBridgeUUIDIfPresent(for key: String) throws -> UUID? {
        guard let value = try decodeIfPresent(String.self, for: key) else {
            return nil
        }
        guard let uuid = NativeBridgeUUID.parse(value) else {
            throw NativeBridgeDecodingError.invalidMessage
        }
        return uuid
    }
}

private extension KeyedEncodingContainer where Key == AnyCodingKey {
    mutating func encode<Value: Encodable>(_ value: Value, for key: String) throws {
        try encode(value, forKey: AnyCodingKey(key))
    }

    mutating func encodeIfPresent<Value: Encodable>(
        _ value: Value?,
        for key: String
    ) throws {
        try encodeIfPresent(value, forKey: AnyCodingKey(key))
    }
}

private extension String {
    func isBridgeNonBlank(maxCodePoints: Int, minCodePoints: Int = 1) -> Bool {
        let count = unicodeScalars.count
        return count >= minCodePoints
            && count <= maxCodePoints
            && first?.isWhitespace == false
            && last?.isWhitespace == false
    }
}
