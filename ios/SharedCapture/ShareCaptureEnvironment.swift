import Foundation

enum ShareCaptureEnvironmentError: Error {
    case missingConfiguration
    case invalidBaseURL
}

struct ShareCaptureEnvironment {
    let baseURL: URL
    let appGroupIdentifier: String
    let keychainAccessGroup: String
    let keychainService: String

    init(bundle: Bundle = .main) throws {
        guard let baseURLValue = bundle.object(
            forInfoDictionaryKey: "MCWebBaseURL"
        ) as? String,
            let appGroupIdentifier = bundle.object(
                forInfoDictionaryKey: "MCAppGroupIdentifier"
            ) as? String,
            let keychainAccessGroup = bundle.object(
                forInfoDictionaryKey: "MCKeychainAccessGroup"
            ) as? String,
            let keychainService = bundle.object(
                forInfoDictionaryKey: "MCKeychainService"
            ) as? String,
            !appGroupIdentifier.isEmpty,
            !keychainAccessGroup.isEmpty,
            !keychainService.isEmpty
        else {
            throw ShareCaptureEnvironmentError.missingConfiguration
        }
        guard let baseURL = URL(string: baseURLValue),
              ShareCaptureValidation.isValidURL(baseURL),
              baseURL.path.isEmpty || baseURL.path == "/",
              baseURL.query == nil,
              baseURL.fragment == nil
        else {
            throw ShareCaptureEnvironmentError.invalidBaseURL
        }
        self.baseURL = baseURL
        self.appGroupIdentifier = appGroupIdentifier
        self.keychainAccessGroup = keychainAccessGroup
        self.keychainService = keychainService
    }
}
