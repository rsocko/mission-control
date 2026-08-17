import UIKit

@MainActor
final class ShareViewController: UIViewController {
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let activityIndicator = UIActivityIndicatorView(style: .medium)
    private let primaryButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)

    private var environment: ShareCaptureEnvironment?
    private var credentialStore: ShareCaptureCredentialStoring?
    private var completionStore: ShareCaptureCompletionStoring?
    private var client: ShareCaptureClient?
    private var submission: ShareCaptureSubmission?

    override func viewDidLoad() {
        super.viewDidLoad()
        configureView()
        Task { await prepareCapture() }
    }

    private func configureView() {
        view.backgroundColor = .systemBackground
        preferredContentSize = CGSize(width: 0, height: 280)

        titleLabel.text = "Save to Mission Control"
        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.textAlignment = .center

        statusLabel.font = .preferredFont(forTextStyle: .body)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.numberOfLines = 0
        statusLabel.textAlignment = .center
        statusLabel.accessibilityIdentifier = "share-capture-status"

        primaryButton.configuration = .filled()
        primaryButton.addTarget(self, action: #selector(primaryAction), for: .touchUpInside)
        primaryButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        primaryButton.isHidden = true

        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
        cancelButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        let stack = UIStackView(arrangedSubviews: [
            titleLabel,
            activityIndicator,
            statusLabel,
            primaryButton,
            cancelButton,
        ])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        showLoading("Checking shared content...")
    }

    private func prepareCapture() async {
        do {
            let environment = try ShareCaptureEnvironment()
            let credentialStore = KeychainShareCaptureCredentialStore(
                service: environment.keychainService,
                accessGroup: environment.keychainAccessGroup
            )
            guard let completionStore = AppGroupShareCaptureCompletionStore(
                appGroupIdentifier: environment.appGroupIdentifier
            ) else {
                showServerFailure(retryable: false)
                return
            }
            let providers = extensionContext?.inputItems
                .compactMap { $0 as? NSExtensionItem }
                .flatMap { $0.attachments ?? [] }
                .map { $0 as ShareItemProviding } ?? []
            let content = try await ShareItemExtractor.extract(from: providers)
            self.environment = environment
            self.credentialStore = credentialStore
            self.completionStore = completionStore
            client = ShareCaptureClient(baseURL: environment.baseURL)
            submission = ShareCaptureSubmission(content: content)
            await submit()
        } catch ShareCaptureInputError.imageUnavailable {
            showInvalidInput("Image sharing is not available yet. No OCR was performed.")
        } catch ShareCaptureInputError.invalidInput {
            showInvalidInput("Share one valid web URL or plain-text item.")
        } catch {
            showServerFailure(retryable: false)
        }
    }

    private func submit() async {
        guard let credentialStore, let client, let submission else {
            showServerFailure(retryable: false)
            return
        }
        let credential: ShareCaptureCredential
        do {
            guard let stored = try credentialStore.read() else {
                showExpiredAuthentication()
                return
            }
            credential = stored
        } catch {
            showExpiredAuthentication()
            return
        }

        showLoading("Saving capture...")
        let outcome = await client.submit(submission, credential: credential)
        switch outcome {
        case let .created(itemId):
            acknowledge(itemId: itemId, status: .created)
        case let .duplicate(itemId):
            acknowledge(itemId: itemId, status: .duplicate)
        case .invalidInput:
            showInvalidInput("This item is not a valid URL or plain-text capture.")
        case .offline:
            showRetry("You are offline. Reconnect and try again.")
        case .timeout:
            showRetry("Mission Control did not respond in time. Try again.")
        case .expiredAuthentication:
            showExpiredAuthentication()
        case let .serverFailure(retryable):
            showServerFailure(retryable: retryable)
        }
    }

    private func acknowledge(itemId: String, status: ShareCaptureCompletion.Status) {
        guard let submission else {
            showServerFailure(retryable: true)
            return
        }
        completionStore?.append(
            ShareCaptureCompletion(
                requestId: submission.requestId,
                status: status,
                itemId: itemId
            )
        )
        activityIndicator.stopAnimating()
        statusLabel.text = status == .created
            ? "Saved to Mission Control."
            : "This capture was already saved."
        statusLabel.accessibilityLabel = statusLabel.text
        primaryButton.setTitle("Done", for: .normal)
        primaryButton.isHidden = false
        primaryButton.accessibilityHint = "Closes the Share Sheet"
    }

    private func showLoading(_ message: String) {
        statusLabel.text = message
        primaryButton.isHidden = true
        activityIndicator.startAnimating()
    }

    private func showInvalidInput(_ message: String) {
        activityIndicator.stopAnimating()
        statusLabel.text = message
        primaryButton.setTitle("Close", for: .normal)
        primaryButton.isHidden = false
    }

    private func showRetry(_ message: String) {
        activityIndicator.stopAnimating()
        statusLabel.text = message
        primaryButton.setTitle("Retry", for: .normal)
        primaryButton.isHidden = false
        primaryButton.accessibilityHint = "Retries with the same capture request"
    }

    private func showExpiredAuthentication() {
        activityIndicator.stopAnimating()
        statusLabel.text = "Share Sheet access expired. Open Mission Control to renew it."
        primaryButton.setTitle("Open Mission Control", for: .normal)
        primaryButton.isHidden = false
    }

    private func showServerFailure(retryable: Bool) {
        activityIndicator.stopAnimating()
        statusLabel.text = retryable
            ? "Mission Control could not save this capture. Try again."
            : "Mission Control could not use this capture."
        primaryButton.setTitle(retryable ? "Retry" : "Close", for: .normal)
        primaryButton.isHidden = false
    }

    @objc
    private func primaryAction() {
        switch primaryButton.title(for: .normal) {
        case "Retry":
            Task { await submit() }
        case "Open Mission Control":
            guard let url = URL(string: "mc://view/capture") else { return }
            extensionContext?.open(url) { [weak self] _ in
                self?.extensionContext?.completeRequest(returningItems: nil)
            }
        default:
            extensionContext?.completeRequest(returningItems: nil)
        }
    }

    @objc
    private func cancel() {
        extensionContext?.cancelRequest(
            withError: NSError(
                domain: NSCocoaErrorDomain,
                code: NSUserCancelledError
            )
        )
    }
}
