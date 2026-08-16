import Foundation
import UniformTypeIdentifiers

@MainActor
protocol ShareItemProviding {
    func hasItemConforming(to typeIdentifier: String) -> Bool
    func loadShareItem(for typeIdentifier: String) async throws -> NSSecureCoding
}

extension NSItemProvider: ShareItemProviding {
    func hasItemConforming(to typeIdentifier: String) -> Bool {
        hasItemConformingToTypeIdentifier(typeIdentifier)
    }

    func loadShareItem(for typeIdentifier: String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let item {
                    continuation.resume(returning: item)
                } else {
                    continuation.resume(throwing: ShareCaptureInputError.invalidInput)
                }
            }
        }
    }
}

@MainActor
enum ShareItemExtractor {
    static func extract(from providers: [ShareItemProviding]) async throws -> ShareCaptureContent {
        for provider in providers where provider.hasItemConforming(to: UTType.url.identifier) {
            let item = try await provider.loadShareItem(for: UTType.url.identifier)
            guard let url = url(from: item), ShareCaptureValidation.isValidURL(url) else {
                throw ShareCaptureInputError.invalidInput
            }
            return .url(url)
        }

        for provider in providers where provider.hasItemConforming(to: UTType.plainText.identifier) {
            let item = try await provider.loadShareItem(for: UTType.plainText.identifier)
            guard let text = text(from: item) else {
                throw ShareCaptureInputError.invalidInput
            }
            return .text(try ShareCaptureValidation.normalizedText(text))
        }

        if providers.contains(where: {
            $0.hasItemConforming(to: UTType.image.identifier)
        }) {
            throw ShareCaptureInputError.imageUnavailable
        }
        throw ShareCaptureInputError.invalidInput
    }

    private static func url(from item: NSSecureCoding) -> URL? {
        if let url = item as? URL {
            return url
        }
        if let url = item as? NSURL {
            return url as URL
        }
        if let value = item as? String {
            return URL(string: value)
        }
        if let data = item as? Data,
           data.count <= 8_192,
           let value = String(data: data, encoding: .utf8)
        {
            return URL(string: value)
        }
        return nil
    }

    private static func text(from item: NSSecureCoding) -> String? {
        if let value = item as? String {
            return value
        }
        if let data = item as? Data,
           data.count <= ShareCapturePayload.maximumTextCodePoints * 4
        {
            return String(data: data, encoding: .utf8)
        }
        return nil
    }
}
