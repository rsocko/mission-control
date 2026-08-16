import Foundation
import Security

protocol ShareCaptureCredentialStoring: AnyObject {
    func read() throws -> ShareCaptureCredential?
    func write(_ credential: ShareCaptureCredential) throws
    func remove() throws
}

enum ShareCaptureCredentialStoreError: Error {
    case encodingFailed
    case keychain(OSStatus)
    case verificationFailed
}

final class KeychainShareCaptureCredentialStore: ShareCaptureCredentialStoring {
    private let service: String
    private let accessGroup: String
    private let account = "share-extension"

    init(service: String, accessGroup: String) {
        self.service = service
        self.accessGroup = accessGroup
    }

    func read() throws -> ShareCaptureCredential? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else {
            throw ShareCaptureCredentialStoreError.keychain(status)
        }
        return try JSONDecoder().decode(ShareCaptureCredential.self, from: data)
    }

    func write(_ credential: ShareCaptureCredential) throws {
        let data = try JSONEncoder().encode(credential)
        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] =
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        addQuery[kSecAttrSynchronizable as String] = false
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(
                baseQuery as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            guard updateStatus == errSecSuccess else {
                throw ShareCaptureCredentialStoreError.keychain(updateStatus)
            }
        } else if status != errSecSuccess {
            throw ShareCaptureCredentialStoreError.keychain(status)
        }
        guard try read() == credential else {
            throw ShareCaptureCredentialStoreError.verificationFailed
        }
    }

    func remove() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ShareCaptureCredentialStoreError.keychain(status)
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

final class NativeShareCredentialLifecycle {
    private let store: ShareCaptureCredentialStoring
    private let completionStore: ShareCaptureCompletionStoring?

    init(
        store: ShareCaptureCredentialStoring,
        completionStore: ShareCaptureCompletionStoring? = nil
    ) {
        self.store = store
        self.completionStore = completionStore
    }

    func install(_ credential: ShareCaptureCredential) throws {
        try store.write(credential)
    }

    func logout() throws {
        try store.remove()
        completionStore?.removeAll()
    }

    func revoke() throws {
        try store.remove()
        completionStore?.removeAll()
    }
}
