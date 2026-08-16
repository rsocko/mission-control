import Foundation

@MainActor
protocol NativeEventDispatching: AnyObject {
    func networkStatusDidChange(_ status: NetworkStatus)
}

@MainActor
final class NoopNativeEventDispatcher: NativeEventDispatching {
    func networkStatusDidChange(_ status: NetworkStatus) {}
}
