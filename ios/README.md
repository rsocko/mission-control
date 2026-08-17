# Mission Control for iOS

This subtree contains the UIKit `WKWebView` application shell, URL/text Share
Extension, and unit tests. The committed project is generated from `project.yml` with
[XcodeGen 2.44.1](https://github.com/yonaskolb/XcodeGen/releases/tag/2.44.1).

## Generate and build

On macOS, use [Mint](https://github.com/yonaskolb/Mint) to run the pinned
generator from this directory:

```sh
mint bootstrap
mint run yonaskolb/XcodeGen@2.44.1 xcodegen generate --spec project.yml
git diff --exit-code MissionControl.xcodeproj
```

Open `MissionControl.xcodeproj` in Xcode 16.4 or run:

```sh
xcodebuild \
  -project MissionControl.xcodeproj \
  -scheme MissionControl \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' \
  CODE_SIGNING_ALLOWED=NO \
  test
```

The app and tests target iOS 17 or newer and compile in Swift 5.10 mode.

## Configuration

`Config/Debug.xcconfig` and `Config/Release.xcconfig` intentionally contain
placeholder values:

```text
MC_APP_BUNDLE_IDENTIFIER = com.example.missioncontrol
MC_WEB_BASE_URL = https://mission-control.example
MC_APP_GROUP_IDENTIFIER = group.com.example.missioncontrol
MC_KEYCHAIN_ACCESS_GROUP = $(AppIdentifierPrefix)com.example.missioncontrol.shared
MC_INSTALLATION_KEYCHAIN_ACCESS_GROUP = $(AppIdentifierPrefix)com.example.missioncontrol.app
MC_APNS_TOPIC = com.example.missioncontrol
MC_APNS_ENVIRONMENT = development
```

The checked-in xcconfig spells the URL as `https:/$()/...` because `$()` keeps
xcconfig's `//` comment syntax from truncating the value; the expanded setting
is the normal `https://...` origin.

Set these values locally or in an uncommitted included xcconfig before running
the app. They can also be overridden for a command-line build:

```sh
xcodebuild -project MissionControl.xcodeproj -scheme MissionControl \
  MC_APP_BUNDLE_IDENTIFIER=com.your-company.missioncontrol \
  MC_WEB_BASE_URL=https://mc.your-company.example build
```

`MC_WEB_BASE_URL` becomes the `MCWebBaseURL` Info.plist value. It must
be an origin only: HTTPS with no credentials, path, query, or fragment. HTTP is
accepted only for `localhost`, `127.0.0.1`, or `[::1]` development. A physical
iPhone cannot reach the Mac through `localhost`; use an HTTPS tunnel or a
properly secured reachable development origin. No ATS exception is included.
Select your own development team in Xcode when signing a device build.
The app target maps `MC_APP_PROVISIONING_PROFILE_SPECIFIER` to Xcode's
`PROVISIONING_PROFILE_SPECIFIER` for externally managed device builds. No
profile name or signing identity is committed.

The Share Extension accepts exactly one `public.url` or `public.plain-text`
item. It rejects image/file input and performs no OCR. It sends the canonical
version 1 payload to `POST /api/triage/capture`, reusing the same request UUID
and `Idempotency-Key` on retry. Offline, timeout, invalid-input, expired-auth,
server-failure, created, and duplicate outcomes remain distinct in the UI.

The capture-only bearer credential is stored with
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` in the app/extension shared
Keychain access group. It is never placed in source, build settings, App Group
defaults, WebKit, or logs. `NativeShareCredentialLifecycle` is the install,
logout, and revocation boundary used by the native bootstrap work; logout and
revocation always remove the local credential. The server stores only its
SHA-256 hash and accepts only unexpired, unrevoked `triage:capture`
credentials. A deployment still needs the separately authenticated PKCE
bootstrap/pairing flow to issue the first credential.

## Architecture and security boundaries

- `TrustedOrigin`, `NavigationPolicy`, and `DeepLinkRouter` normalize the
  configured origin, enforce exact scheme/host/port equality, constrain
  top-level paths, and validate `mc://` and universal links.
- `WebViewController` keeps trusted pages in the web view, hands other HTTP(S)
  origins to `ExternalURLOpening`, blocks unsafe schemes, enables navigation
  gestures, grants microphone capture only to the exact trusted main frame,
  and exposes a diagnostic-only User-Agent suffix.
- `NativeContextScript` is a main-frame document-start script whose runtime
  origin guard exposes only a frozen platform and contract-version context.
- `WebBridge` owns the single `WKScriptMessageHandler`, validates closed v1
  envelopes at the exact trusted main-frame origin, and dispatches typed
  responses and events through the frozen `window.mcNativeBridge` API.
- `NetworkStatusMonitoring` reports `NWPathMonitor` state through the
  `NativeEventDispatching` seam. Normal navigation gets the first service
  worker opportunity; a network navigation failure then requests `/~offline`.
- The Share Extension keeps captured content out of WebKit. After an API
  acknowledgement it stores only request ID, `created|duplicate`, and item ID
  in bounded App Group completion metadata. On activation the app consumes
  that metadata through `NativeBridgeEventSending.shareCaptureDidComplete`.
- `KeychainShareCaptureCredentialStore` and
  `AppGroupShareCaptureCompletionStore` separate secret storage from
  non-secret cross-process handoff. No captured content is queued on disk in
  this initial slice; offline and timeout states remain visible and retryable
  in the extension.

`NativeBridgeActionHandling`, `NativeAuthenticationStateProviding`, and
`NativeBridgeEventSending` remain closed typed seams. No credentials, captured
content, or device tokens cross the bridge. The application-only Keychain group
stores the installation credential; APNs tokens go directly to the
authenticated native registration API and are never placed in WebKit, App Group
defaults, or logs. Debug builds use the APNs sandbox and Release builds use
production. PKCE bootstrap issuance, signing assets, provider credentials, and
production bundle/team values remain externally provisioned. The upstream
native authentication coordinator must install the issued credential through
`NativePushSession.install(_:)` and call `PushNotificationManager.logout()` on
native logout; version 1 intentionally does not expose credentials or logout as
a JavaScript bridge action.

The public repository owns this source, the generated Xcode project, and the
unsigned simulator inputs in `.xcode-version`, `Mintfile`, `project.yml`, and
`release-contract.json`. A separate private release controller owns macOS
runner selection, signing, provisioning, archives, and distribution. See
`../docs/development/mobile-ios-device-validation.md` for the public validation
commands and `../docs/development/ios-distribution-operations.md` for the
two-repository handoff boundary.

The controller is pull-based: an operator manually supplies a full public commit
SHA, and the controller fetches and validates that exact commit in a temporary
detached checkout. This subtree is not mirrored or included as a submodule, and
public workflows cannot trigger private controller workflows. Changes to the
release contract, toolchain pins, project structure, generated project, build
phases, or audited native source require a corresponding private controller
review before that commit is eligible to run there.

The router validates universal-link URLs today, but iOS delivery of those links
is intentionally not claimed by this scaffold. The owner must first select the
production HTTPS domain, publish its reviewed `apple-app-site-association`
file, add the exact `applinks:<owner-controlled-domain>` entitlement, and
regenerate the matching provisioning profile. A placeholder or wildcard
associated domain is not committed.
