---
title: "Mobile iOS Device Validation"
sidebar_label: iOS Device Validation
status: active
created: 2026-08-16
last_reviewed: 2026-08-16
category: reference
---

# Mobile iOS Device Validation

The public repository owns the iOS source, generated Xcode project, native
contract tests, and unsigned simulator validation inputs. A separate private
release controller owns macOS runner selection, signing material, provisioning,
archives, and distribution. Do not add those private concerns to this
repository.

See [iOS Release Handoff](ios-distribution-operations.md) for the two-repository
ownership model and the public contract consumed by that controller.

## Public source validation

On macOS with Xcode 16.4 and Mint installed:

```sh
cd ios
mint bootstrap
mint run yonaskolb/XcodeGen@2.44.1 xcodegen generate --spec project.yml
git diff --exit-code MissionControl.xcodeproj
xcodebuild \
  -project MissionControl.xcodeproj \
  -scheme MissionControl \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' \
  CODE_SIGNING_ALLOWED=NO \
  test
```

The checked-in `release-contract.json` is a source-controlled input consumed by
the private controller. It identifies the public project, scheme, simulator
destination, and unsigned signing mode; it does not select a runner or contain
signing or distribution policy.

The controller is pull-based and manually receives a full public Git commit SHA.
It fetches that exact commit into a temporary detached checkout and validates
the audited source and toolchain before executing it. There is no submodule,
automatic synchronization, or public workflow that triggers the private
controller.

## Physical-device record

Simulator results do not validate physical-device behavior. Record the
following for each device pass:

| Field | Value |
|---|---|
| Date/time | |
| Operator | |
| Commit or release-candidate build | |
| Environment URL | |
| iPhone model | |
| iOS version | |
| Network used | |
| Result | Pass / Fail / Blocked |
| Linked defects | |

Use a reachable HTTPS environment. A physical iPhone cannot reach the
development machine through the phone's `localhost`.

Validate launch and authentication, trusted and external navigation, bridge
actions, push permission handling, deep links, offline fallback, Share
Extension URL and text capture, duplicate and retry behavior, Keychain access
groups, safe areas, keyboard interaction, VoiceOver labels, and 44-point touch
targets. Keep device evidence and release approval in the private release
system rather than committing credentials, provisioning details, runner
configuration, or distribution records here.
