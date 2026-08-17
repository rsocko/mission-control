import SafariServices
import UIKit

@MainActor
protocol ExternalURLOpening {
    func open(_ url: URL, from presenter: UIViewController)
}

struct SafariExternalURLOpener: ExternalURLOpening {
    func open(_ url: URL, from presenter: UIViewController) {
        presenter.present(SFSafariViewController(url: url), animated: true)
    }
}
