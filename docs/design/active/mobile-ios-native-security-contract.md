---
title: "Mobile iOS Native Bridge and API Security Contract"
status: active
created: 2026-07-31
last_reviewed: 2026-07-31
category: design
contract_version: 1
related:
  - "[iOS wrapper and distribution plan](../proposed/mobile-ios-wrapper-distribution.md)"
  - "[Mobile iOS execution baseline](mobile-ios-execution-plan.md)"
  - "[Mobile iOS redesign](mobile-ios-redesign.md)"
mockups:
  - "[Siri, Shortcuts, and Share Sheet](../../mockups/mockup-ios-siri-shortcuts-share.html)"
---

# Mobile iOS Native Bridge and API Security Contract

This document is the canonical contract for issues #932-#935. The executable
TypeScript schemas and guards live in `src/lib/native/contract.ts`. The
language-neutral generated artifact is
`contracts/mobile-ios-native-v1.schema.json`; regenerate it with
`npm run contract:ios`. Swift code must mirror that schema with `Codable`
types, but the Xcode and Swift scaffolding remain scoped to #932 and #933.

The issue requirements and this contract take precedence over the mockup. In
particular, the mockup shows image and OCR capture as a future interaction.
Version 1 accepts URL and text only. Image ingestion is blocked on #1656, and
OCR is not implied by that dependency.

## Versioning and compatibility

Version 1 uses the integer `1` in every bridge and native API envelope.

- Producers must send `version`.
- Consumers must reject unknown versions without performing a side effect.
- Fields are closed: unknown actions and undeclared fields are invalid.
- A breaking field, action, authentication, or semantic change requires a new
  version and an explicit migration period. Additive optional response fields
  may remain in the same version only when old consumers safely ignore them.
- Bridge requests and native API mutations use a UUID `requestId`. It is both a
  correlation identifier and the API idempotency key. It is not a credential.

The TypeScript schema is the machine-readable source for field names,
constraints, and enums. Swift `CodingKeys` must preserve those JSON names.
String length bounds use Unicode code points, matching JSON Schema
`minLength`/`maxLength` semantics rather than UTF-16 code units.

## JavaScript/native bridge

### Request envelope

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "action": "hapticFeedback",
  "payload": {
    "type": "impact",
    "intensity": 0.5
  }
}
```

Web-to-native actions in version 1:

| Action | Payload | Native side effect |
| --- | --- | --- |
| `bootstrap` | `webClientVersion` | Return non-secret native capability and authentication state |
| `requestPushPermission` | `context` | Show the system notification prompt after a contextual web prompt |
| `hapticFeedback` | `type`, optional `intensity` | Produce the declared feedback only |
| `openURL` | HTTP(S) `url` | Open outside the privileged web view |
| `setBadge` | integer `count` from 0 through 999 | Set the application badge |

The haptic payload remains version-1 compatible. `impact` intensity below `0.5`
selects a light impact and higher intensity selects a medium impact; `selection`
produces a soft threshold tick. `success` without intensity is task-completion
feedback, while `success` with intensity `1` is the triage-completion
three-tap crescendo. UIKit and Core Haptics remain responsible for honoring
system haptics preferences, and reduced-motion clients must not request feedback.

Native-to-web events use the same `version`, `requestId`, `action`, and
`payload` shape. Version 1 events are `authenticationChanged`,
`networkStatus`, `pushRegistrationChanged`, and `shareCaptureCompleted`.
Neither an APNs token nor an API credential may cross the bridge.

The older wrapper proposal suggested a `pushToken` bridge event. Version 1
replaces it with native-to-server registration. The web layer receives only
authorization state and an opaque registration ID. A
`pushRegistrationChanged` event requires `registrationId` only when
`state` is `registered`; all other states must omit it.

### Response envelopes

Success:

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "action": "requestPushPermission",
  "ok": true,
  "result": {
    "authorization": "authorized"
  }
}
```

Error:

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "action": "requestPushPermission",
  "ok": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Notifications are disabled",
    "retryable": false
  }
}
```

The allowed bridge error codes are defined by
`nativeBridgeErrorCodeSchema`. Messages are safe for display and must not
contain tokens, raw shared content, or platform exception dumps. Error
envelopes are closed and do not permit an arbitrary `details` object; native
diagnostics remain in redacted platform logs.

### Handler and message rules

The #933 implementation must:

1. Register one bridge handler name and dispatch only schema-declared actions.
2. Accept messages only from the main frame whose `WKSecurityOrigin` exactly
   matches the normalized configured Mission Control origin.
3. Validate the full envelope before dispatch. A malformed message has no side
   effect and receives `INVALID_MESSAGE` when a valid `requestId` is available.
4. Cap serialized messages at 64 KiB before decoding.
5. Track outstanding request IDs, reject duplicate in-flight IDs, and discard
   unsolicited or late responses.
6. Remove or disable handlers before committing a navigation outside the
   trusted origin.
7. Never expose Keychain access, arbitrary native selectors, file access,
   arbitrary URL schemes, APNs tokens, or API credentials as bridge actions.
8. Redact payloads from production logs. Logging version, action, request ID,
   duration, and result code is sufficient.

## Trusted origin, navigation, and deep links

`MCWebBaseURL` is an origin, not a URL prefix. Production requires HTTPS and
must not contain credentials, a path, query, or fragment. HTTP is accepted only
for `localhost`, `127.0.0.1`, and `[::1]` development. Origins must use
canonical hostname syntax; a trailing DNS dot is rejected.

Bridge privilege requires exact scheme, host, and port equality. Subdomains,
lookalike suffixes, redirects, iframes, popups, and user-provided origins are
not trusted. URLs containing username/password userinfo are rejected rather
than loaded internally or opened externally. For example,
`https://mc.example.com.evil.test` is external.

`classifyNativeNavigation` implements the version 1 top-level path allowlist:

```text
/
/ai
/capture
/goals
/insights
/notifications
/projects
/quick-sort
/routines
/settings
/today
/triage
```

Child paths under an allowed non-root path are allowed. Same-origin `/api`,
`/_next`, `/mcp-widgets`, and undeclared pages are not top-level navigation
targets. HTTP(S) links on other origins open in `SFSafariViewController` or the
system browser without bridge injection. `javascript:`, `data:`, `file:`,
`blob:`, and unknown schemes are rejected.

Version 1 deep links are:

| Input | Trusted web destination |
| --- | --- |
| `mc://view/today` | `/today` |
| `mc://view/triage` | `/triage` |
| `mc://view/capture` or `mc://capture` | `/capture` |
| `mc://view/quick-sort` | `/quick-sort` |
| `mc://view/houston` | `/ai` |

Universal links must use the configured origin and the same path allowlist.
Query values are treated as untrusted page input. Unknown deep links fail
closed and may open the app's default page only after dropping all input.

## Authentication and bootstrap

Mission Control currently has deployment API keys and
`MC_TRIAGE_CAPTURE_KEY`, but it does not expose a generic user session token
that is safe to embed in a native binary. Those static secrets must not be
copied into source, build settings, `Info.plist`, App Group preferences, crash
reports, bridge messages, or device logs.

Version 1 uses an authorization-code bootstrap with PKCE:

1. The native app creates a high-entropy verifier, SHA-256 challenge, random
   state, and installation UUID.
2. It opens the configured origin's native authorization page using
   `ASWebAuthenticationSession`. The deployment authenticates or explicitly
   pairs the user and binds a single-use code to the challenge, state,
   installation, origin, and a five-minute maximum lifetime.
3. The callback is exactly `mc://auth/callback`. Native validates state and
   exchanges the code and verifier with `POST /api/native/bootstrap`.
4. The server atomically consumes the code. Reuse returns `REPLAY_DETECTED`.
5. The response supplies the normalized trusted origin, bridge version, an
   app-only installation credential, and optionally a Share Extension
   credential. No credential enters JavaScript.
6. The WKWebView separately uses the deployment's normal secure,
   HttpOnly-cookie web session. The bridge reports only coarse authentication
   state.

The bootstrap endpoint is a contract for #932/#933; it is not present in the
current server. A deployment that cannot authenticate or explicitly pair the
authorization request is not eligible for native bootstrap. It must not fall
back to an embedded `MC_API_KEY` or `MC_TRIAGE_CAPTURE_KEY`.

Request:

```http
POST /api/native/bootstrap
Content-Type: application/json

{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "installationId": "570ce945-1433-40f3-92c6-af7c14343acd",
  "authorizationCode": "single-use-opaque-code-at-least-32-characters",
  "codeVerifier": "PKCE-verifier-at-least-43-characters-long....",
  "redirectUri": "mc://auth/callback",
  "appVersion": "1.0.0",
  "buildNumber": 42
}
```

### Credential separation and storage

| Credential | Scopes | Storage/access |
| --- | --- | --- |
| Installation | exactly `push:register`, `push:unregister`, `credentials:rotate`, and `credentials:revoke` | App-only Keychain access group |
| Share Extension | exactly `triage:capture` | Keychain access group shared only by the app and Share Extension |

Use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Do not synchronize
native credentials through iCloud Keychain. App Group `UserDefaults` may hold
non-secret configuration such as the trusted origin and installation ID, but
never an access token or APNs token.

If the Share Extension queues content while offline, use the App Group
container with complete file protection, bounded item count and byte size, no
backup, and deletion after acknowledged upload. Queue records contain only the
minimum capture payload and request ID.

Credential responses carry a positive `expiresInSeconds`, capped at 90 days
for installation credentials and 30 days for Share Extension credentials.
Clients derive expiry from the validated `issuedAt` timestamp and duration and
rotate before seven days remain:

1. Fetch a replacement through an authenticated app-only request.
2. Atomically write and verify the new Keychain item.
3. Switch callers to the new credential.
4. Revoke the prior credential server-side.
5. Remove the prior Keychain item.

Rotation is `POST /api/native/credentials/rotate`, authenticated by the current
installation credential with `credentials:rotate`, and uses
`nativeCredentialRotationRequestSchema`. The response is
`nativeCredentialRotationResponseSchema`, whose declared `credentialKind`
must match the returned credential. The server invalidates the prior
credential only after successfully issuing the replacement.

Individual revocation is
`DELETE /api/native/credentials/{credentialId}`, authenticated with
`credentials:revoke`, and uses `nativeCredentialRevocationRequestSchema`.
Revocation is idempotent; an already-revoked credential returns success
without reactivating it.

The extension has no refresh credential. If its credential expires, it keeps a
protected bounded queue and asks the user to open the main app.

Logout must first request APNs unregistration and credential revocation when
online, then remove both local credentials, cookies, protected queued content,
and cached account data even if the network request fails. Server credentials
remain independently revocable. APNs invalid-token feedback and credential
expiry cover uninstall, where no logout callback exists.

Online logout uses `POST /api/native/logout`, the app-only installation
credential with `credentials:revoke`, and `nativeLogoutRequestSchema`. The
server derives identity from the authenticated credential and atomically
revokes every installation and Share Extension credential and retires every
APNs registration bound to that installation. The caller cannot select or omit
individual records. The server returns `nativeLogoutResponseSchema`. The
client always performs local cleanup after the request completes or fails.

## APNs registration contract

APNs is a channel behind the shared notification policy/outbox architecture.
It must not reuse the Web Push `push_subscriptions` row, whose endpoint and
VAPID key shape is incompatible.

Registration uses the app-only installation credential with
`push:register`:

```http
POST /api/native/push/registrations
Authorization: Bearer <installation credential>
Idempotency-Key: 8cf177a0-e46a-46fa-824c-4c34004e2423
Content-Type: application/json

{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "installationId": "570ce945-1433-40f3-92c6-af7c14343acd",
  "deviceToken": "<lowercase-or-uppercase-hex-token>",
  "environment": "production",
  "topic": "com.example.missioncontrol",
  "appVersion": "1.0.0",
  "buildNumber": 42,
  "locale": "en-US",
  "timeZone": "America/New_York"
}
```

Success:

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "ok": true,
  "data": {
    "registrationId": "c83d74ec-d4a1-45f7-8153-79fdb63cafb9",
    "state": "registered",
    "updatedAt": "2026-07-31T12:00:00.000Z"
  }
}
```

Token changes use the same endpoint and return `state: "rotated"`. The unique
server identity is installation, APNs environment, and topic; store only the
token required for delivery, encrypt it at rest where deployment facilities
permit, and never log it.

Unregistration uses `DELETE /api/native/push/registrations/{registrationId}`
with `push:unregister`, the versioned `apnsUnregistrationRequestSchema` body,
and an idempotency key. Logout, user-disabled notifications, credential
revocation, APNs invalidation feedback, and environment/topic changes retire a
registration. A production token must never be sent to the development APNs
endpoint or vice versa.

## Share Sheet capture contract

Version 1 accepts `public.url` and `public.plain-text`. The endpoint is the
existing `POST /api/triage/capture`; #935 must adapt that handler to
`shareSheetCaptureRequestSchema` while retaining compatibility for existing
browser-extension clients.

The extension sends its capture-only bearer credential and uses `requestId` as
the idempotency key:

```http
POST /api/triage/capture
Authorization: Bearer <share-extension credential>
Idempotency-Key: 8cf177a0-e46a-46fa-824c-4c34004e2423
Content-Type: application/json

{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "client": "ios",
  "contentType": "url",
  "url": "https://example.com/async-retrospectives",
  "title": "How to run better async retrospectives",
  "sharedText": "Optional selected text",
  "capturedAt": "2026-07-31T12:00:00.000Z"
}
```

Text request:

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "client": "ios",
  "contentType": "text",
  "text": "Draft priorities for Q4 planning and send to leadership.",
  "capturedAt": "2026-07-31T12:00:00.000Z"
}
```

Success:

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "ok": true,
  "data": {
    "itemId": "triage-item-id",
    "status": "created"
  }
}
```

The server stores the first successful result by credential and request ID for
at least 24 hours. An exact retry returns the same item with `duplicate`.
Reusing an ID with different content returns `REPLAY_DETECTED`. The server
applies per-credential rate and body-size limits, validates HTTP(S) URLs,
normalizes text, and relies on downstream metadata fetching defenses rather
than trusting client metadata.

`public.image`, screenshots, files, base64 data, and OCR fields fail validation
with `IMAGE_CAPTURE_UNAVAILABLE` until #1656 supplies the approved upload and
storage contract. A remote image URL does not turn a URL capture into an image
upload.

### API error envelope

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "ok": false,
  "error": {
    "code": "TOKEN_EXPIRED",
    "message": "Open Mission Control to renew Share Sheet access.",
    "retryable": false
  }
}
```

Version 1 API codes are `INVALID_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`,
`TOKEN_EXPIRED`, `REPLAY_DETECTED`, `RATE_LIMITED`,
`IMAGE_CAPTURE_UNAVAILABLE`, and `INTERNAL_ERROR`. Production responses do not
include stack traces, database errors, tokens, APNs values, or captured
content.

## Threat model

| Threat | Boundary/impact | Required mitigation |
| --- | --- | --- |
| Origin confusion | Attacker content gains native privilege through lookalike host, redirect, iframe, or popup | Exact normalized origin and main-frame checks; path allowlist; remove handlers before external navigation |
| Arbitrary script messages | Trusted-page XSS or malformed data invokes undeclared native behavior | Closed versioned schemas, fixed action dispatch, 64 KiB cap, no dynamic selector dispatch, no secrets/file APIs |
| Token leakage | JavaScript, logs, App Group defaults, backups, or crash reports expose credentials/APNs token | Keychain separation, device-only accessibility, no bridge tokens, payload redaction, no secret-bearing analytics |
| Replay | Retried or stolen capture/bootstrap requests create duplicates or reissue credentials | PKCE single-use code, UUID request IDs, idempotency storage, payload binding, short bootstrap lifetime |
| Captured-content abuse | Malformed URL/text drives SSRF, stored XSS, oversized payload, or metadata poisoning | HTTP(S)-only URL validation, text/body limits, output escaping, server-side metadata validation and fetch protections |
| Navigation injection | Deep/universal link opens privileged internal or unsafe scheme | Exact declared link map and web path allowlist; reject unknown schemes and externalize other origins |
| Over-privileged extension | Compromised Share Extension mutates tasks or manages push | Separate credential with exactly `triage:capture`; no refresh token; independent expiry/revocation/rate limit |
| Stale APNs registration | Logout, rotation, reinstall, or APNs invalidation leaves a deliverable token | Explicit unregister, installation binding, environment/topic checks, provider invalidation retirement |
| Offline data exposure | Shared text/URLs remain readable in App Group storage | Complete file protection, bounded no-backup queue, minimal fields, delete after acknowledgement/logout |
| Downgrade/fallback | Unsupported version silently uses an unsafe legacy behavior | Reject unknown versions; no fallback to static deployment keys or unversioned bridge dispatch |

## Downstream implementation checklist

- #932: use the origin normalization, navigation classifier, deep-link map,
  PKCE bootstrap, and storage rules from this contract.
- #933: mirror the bridge schemas with Swift `Codable` enums/structs and add no
  action outside the version 1 union.
- #934: implement the APNs endpoints and channel-specific persistence behind
  the shared notification policy/outbox.
- #935: implement URL/text Share Extension capture against
  `/api/triage/capture`, idempotency, queue protection, and the capture-only
  Keychain credential. Keep image input disabled pending #1656.

Any downstream change to these assumptions updates the TypeScript schemas,
tests, and this document in one pull request.
