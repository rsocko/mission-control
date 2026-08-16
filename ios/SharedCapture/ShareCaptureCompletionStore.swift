import Foundation

protocol ShareCaptureCompletionStoring: AnyObject {
    func append(_ completion: ShareCaptureCompletion)
    func consumeAll() -> [ShareCaptureCompletion]
    func removeAll()
}

final class AppGroupShareCaptureCompletionStore: ShareCaptureCompletionStoring {
    private let defaults: UserDefaults
    private let key = "native.share-capture.completions.v1"
    private let maximumCompletions = 20

    init?(appGroupIdentifier: String) {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier) else {
            return nil
        }
        self.defaults = defaults
    }

    func append(_ completion: ShareCaptureCompletion) {
        var completions = decoded()
        completions.append(completion)
        if completions.count > maximumCompletions {
            completions.removeFirst(completions.count - maximumCompletions)
        }
        defaults.set(try? JSONEncoder().encode(completions), forKey: key)
    }

    func consumeAll() -> [ShareCaptureCompletion] {
        let completions = decoded()
        defaults.removeObject(forKey: key)
        return completions
    }

    func removeAll() {
        defaults.removeObject(forKey: key)
    }

    private func decoded() -> [ShareCaptureCompletion] {
        guard let data = defaults.data(forKey: key),
              let values = try? JSONDecoder().decode(
                  [ShareCaptureCompletion].self,
                  from: data
              )
        else {
            return []
        }
        return values
    }
}
