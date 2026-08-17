import Foundation
import Network

enum NetworkStatus: String, Codable, Equatable, Sendable {
    case online
    case offline
}

protocol NetworkStatusMonitoring: AnyObject {
    var statusHandler: ((NetworkStatus) -> Void)? { get set }
    func start()
    func cancel()
}

final class NetworkMonitor: NetworkStatusMonitoring {
    var statusHandler: ((NetworkStatus) -> Void)?

    private let monitor: NWPathMonitor
    private let queue = DispatchQueue(label: "com.example.missioncontrol.network-monitor")
    private var isStarted = false

    init(monitor: NWPathMonitor = NWPathMonitor()) {
        self.monitor = monitor
    }

    func start() {
        guard !isStarted else { return }
        isStarted = true
        monitor.pathUpdateHandler = { [weak self] path in
            let status: NetworkStatus = path.status == .satisfied ? .online : .offline
            DispatchQueue.main.async {
                self?.statusHandler?(status)
            }
        }
        monitor.start(queue: queue)
    }

    func cancel() {
        guard isStarted else { return }
        monitor.cancel()
        isStarted = false
    }

    deinit {
        monitor.cancel()
    }
}
