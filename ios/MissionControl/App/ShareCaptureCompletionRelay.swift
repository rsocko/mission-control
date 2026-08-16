import Foundation

@MainActor
final class ShareCaptureCompletionRelay {
    private let store: ShareCaptureCompletionStoring

    init(store: ShareCaptureCompletionStoring) {
        self.store = store
    }

    func deliverPending(to sender: NativeBridgeEventSending) {
        for completion in store.consumeAll() {
            guard !completion.itemId.isEmpty,
                  completion.itemId.unicodeScalars.count <= 128
            else {
                continue
            }
            sender.shareCaptureDidComplete(
                requestId: completion.requestId,
                status: completion.status == .created ? .created : .duplicate,
                itemId: completion.itemId
            )
        }
    }
}
