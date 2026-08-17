import Foundation

enum AppConfigurationError: LocalizedError {
    case missingWebBaseURL
    case invalidWebBaseURL(Error)
    case missingValue(String)
    case invalidAPNsEnvironment

    var errorDescription: String? {
        switch self {
        case .missingWebBaseURL:
            "MCWebBaseURL is missing from Info.plist."
        case let .invalidWebBaseURL(error):
            "MCWebBaseURL is invalid: \(error.localizedDescription)"
        case let .missingValue(name):
            "\(name) is missing from Info.plist."
        case .invalidAPNsEnvironment:
            "MCAPNsEnvironment must be development or production."
        }
    }
}

enum NativeAPNsEnvironment: String, Codable {
    case development
    case production
}

struct AppConfiguration {
    let trustedOrigin: TrustedOrigin
    let apnsEnvironment: NativeAPNsEnvironment
    let apnsTopic: String
    let installationKeychainAccessGroup: String
    let installationKeychainService: String

    init(bundle: Bundle = .main) throws {
        guard let value = bundle.object(forInfoDictionaryKey: "MCWebBaseURL") as? String,
              !value.isEmpty
        else {
            throw AppConfigurationError.missingWebBaseURL
        }

        do {
            trustedOrigin = try TrustedOrigin(value)
        } catch {
            throw AppConfigurationError.invalidWebBaseURL(error)
        }

        guard let environmentValue = bundle.object(
            forInfoDictionaryKey: "MCAPNsEnvironment"
        ) as? String,
            let environment = NativeAPNsEnvironment(rawValue: environmentValue)
        else {
            throw AppConfigurationError.invalidAPNsEnvironment
        }
        apnsEnvironment = environment
        apnsTopic = try Self.requiredValue("MCAPNsTopic", bundle: bundle)
        installationKeychainAccessGroup = try Self.requiredValue(
            "MCInstallationKeychainAccessGroup",
            bundle: bundle
        )
        installationKeychainService = try Self.requiredValue(
            "MCInstallationKeychainService",
            bundle: bundle
        )
    }

    private static func requiredValue(_ key: String, bundle: Bundle) throws -> String {
        guard let value = bundle.object(forInfoDictionaryKey: key) as? String,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw AppConfigurationError.missingValue(key)
        }
        return value
    }
}
