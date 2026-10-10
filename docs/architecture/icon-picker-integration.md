# Icon picker package integration

Mission Control consumes a generated package snapshot of
`@rsocko/icon-picker`. The canonical source is
`https://github.com/rsocko/icon-picker`. The reviewed package version, exact
merged `main` commit, npm toolchain, and artifact integrity values are recorded
in `scripts/icon-picker-vendor-pin.json`.

The standalone repository is the only editable source of truth. Files under
`vendor/icon-picker/` are generated package output and must not be hand-edited.
The snapshot contains only the package's publishable files plus provenance
metadata. `UPSTREAM.json` records the source commit, canonicalization contract,
and deterministic npm artifact metadata. `icon-picker.snapshot.json` records a
SHA-256 for every extracted publishable file. Mission Control imports the normal
package exports and stylesheet, so moving to a registry dependency later does
not require application-code changes.

The package is pinned as a local file dependency:

```json
"@rsocko/icon-picker": "file:vendor/icon-picker"
```

This keeps local development, CI, Docker builds, and cloud-agent workflows
independent of npmjs, GitHub Packages credentials, a sibling checkout,
submodules, and synchronization-time network access.

## Verify the committed snapshot

Verification is self-contained and does not access the network:

```powershell
npm run vendor:icon-picker:verify
```

The verifier checks the exact package name, version, export map, file allowlist,
canonical provenance, artifact size, unpacked size, entry count, npm integrity,
SHA-1, SHA-256, and SHA-512. It then verifies every committed publishable file
against the hashes captured from the validated upstream artifact. Verification
does not require npm version parity or network access.

The aggregate command verifies every vendored integration:

```powershell
npm run vendor:verify
```

## Automated synchronization

The **Sync icon picker vendor** GitHub Actions workflow checks upstream every
day at 09:17 UTC. When the latest merged `main` commit changes the deterministic
snapshot, it creates or updates the single
`automation/icon-picker-vendor-sync` review branch and pull request. It does
not auto-merge, publish, tag, or release anything. Repeated runs replace that
branch from current Mission Control `main`, so they do not create duplicate
pull requests.

To run it on demand, open **Actions**, select **Sync icon picker vendor**, and
choose **Run workflow**. Leave `commit` empty to use the latest upstream
`main`, or enter a full lowercase 40-character commit SHA already merged into
upstream `main`. A commit outside that history is rejected.

Synchronization is never run during installation, application startup, tests,
or production builds. For local troubleshooting, use the reviewed commit from
the pin:

```powershell
npm run vendor:icon-picker:sync -- --commit <reviewed-commit>
```

The command:

1. Clones the canonical upstream repository into a temporary directory and
   checks out the exact immutable commit.
2. Refuses a commit that differs from Mission Control's reviewed pin unless
   the automation explicitly requests a reviewable pin update.
3. Requires the corporate npm registry locally and the public npm registry in
   GitHub Actions.
4. Uses the upstream-pinned npm version from the approved registry and restores
   the locked upstream dependencies with the approved-registry policy.
5. Runs upstream `package:artifact` from the clean exact commit using that npm
   version.
6. Checks package identity, exports, file allowlist, artifact metadata, hashes,
   integrity, and provenance.
7. Records and verifies per-file hashes from the validated extracted artifact.
8. Replaces `vendor/icon-picker/` atomically only after all checks pass.

To advance upstream without the workflow, run the synchronization command with
`--update-pin true`, refresh `package-lock.json`, and submit the complete
generated diff for review. The automation is preferred because it performs
those steps consistently.

## Mission Control boundary

Picker and renderer consumers import `@rsocko/icon-picker` subpath exports.
Portable stored strings remain unchanged: raw emoji, prefixed provider values,
and legacy bare Lucide names require no database migration.

Mission Control consumes the picker and renderer only inside product workflows.
The standalone icon-picker deployment owns the public explorer and demo.
