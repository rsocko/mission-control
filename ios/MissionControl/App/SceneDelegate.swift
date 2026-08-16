import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var webViewController: WebViewController?
    private var shareCaptureCompletionRelay: ShareCaptureCompletionRelay?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let rootViewController: UIViewController
        do {
            let configuration = try AppConfiguration()
            let pushManager = PushNotificationManager.shared
            let actionHandler = SystemNativeBridgeActionHandler(
                authenticationStateProvider: pushManager,
                pushPermissionHandler: pushManager
            )
            let webViewController = WebViewController(
                configuration: configuration,
                actionHandler: actionHandler
            )
            self.webViewController = webViewController
            pushManager.configure(
                configuration: configuration,
                eventSender: webViewController.nativeBridgeEventSender,
                openDestination: { [weak webViewController] url in
                    webViewController?.openValidatedLink(url)
                }
            )
            if let environment = try? ShareCaptureEnvironment() {
                shareCaptureCompletionRelay = AppGroupShareCaptureCompletionStore(
                    appGroupIdentifier: environment.appGroupIdentifier
                ).map(ShareCaptureCompletionRelay.init)
            }
            rootViewController = webViewController
        } catch {
            rootViewController = ConfigurationErrorViewController(error: error)
        }

        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = rootViewController
        self.window = window
        window.makeKeyAndVisible()

        if let url = connectionOptions.urlContexts.first?.url {
            webViewController?.openValidatedLink(url)
        } else if let activity = connectionOptions.userActivities.first,
                  activity.activityType == NSUserActivityTypeBrowsingWeb,
                  let url = activity.webpageURL
        {
            webViewController?.openValidatedLink(url)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let url = URLContexts.first?.url else { return }
        webViewController?.openValidatedLink(url)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL
        else {
            return
        }

        webViewController?.openValidatedLink(url)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        PushNotificationManager.shared.refreshAuthorizationAndRegistration()
        if let webViewController, let shareCaptureCompletionRelay {
            shareCaptureCompletionRelay.deliverPending(
                to: webViewController.nativeBridgeEventSender
            )
        }
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        webViewController?.tearDown()
        webViewController = nil
    }
}
