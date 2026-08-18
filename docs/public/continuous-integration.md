# Continuous integration and container publication

The public repository uses only GitHub-hosted `ubuntu-24.04` runners. Pull
requests and pushes to `main` install the locked dependencies, validate workflow
policy, lint, run unit tests, smoke-test the worker runtime, and build the
production application. Fork pull requests use a read-only `GITHUB_TOKEN`,
receive no protected secrets, and cannot publish a container.

CI restores npm's content-addressed download cache on every run. Only the
successful workflow-policy job on `main` may save a cache, so parallel jobs do
not race to upload the same archive and pull-request merge refs cannot create
duplicates. The key includes the operating system, architecture, and lockfile
hash; older `main` entries remain eligible as restore prefixes and age out under
GitHub's normal retention policy.

Automatic container publication runs only after the `CI` workflow succeeds for
a `push` event whose exact source commit and repository are `main` in this
repository. The privileged workflow checks out the completed run's immutable
`head_sha`, verifies it is still in `origin/main` history, and never consumes
pull-request artifacts or contributor-controlled refs.

Manual publication requires a full lowercase commit SHA and is allowed only
when the workflow itself is dispatched from `main`. A read-only job fetches
`origin/main` and verifies that SHA is an ancestor before the privileged job
checks out the exact commit and repeats both the checkout and ancestry checks.
Branch names and the dispatch context's default SHA are never publication
sources. Manual runs support `explicit`, `next_major`, `next_minor`, and
`next_patch` version modes and may optionally update `latest`.

All publications are globally serialized so semantic-version discovery cannot
race another publication. A successful automatic publication reserves both the
next patch version (starting at `0.1.0` in a registry with no semantic tags) and
`sha-<7-character-commit>`. The workflow builds and pushes by digest, attaches a
BuildKit-generated SBOM, and signs GitHub-generated SLSA provenance for that
exact digest before promoting it to the semantic-version tag, SHA tag, and
`latest`. It refuses to overwrite either immutable tag and verifies every
promoted tag resolves to the attested digest.

## Build cache policy

Container publication imports and exports a BuildKit GitHub Actions cache under
the application-only scope `mission-control-app-v1`. The reserved scope for any
future Copilot Adapter image is `mission-control-copilot-adapter-v1`; the two
images must never share a scope.

The application uses `mode=max`. `mode=min` retains only layers in the final
runtime image, but the expensive dependency installation and application
compilation occur in the intermediate builder stage. Exporting intermediate
layers therefore provides the useful reuse. Cache export uses
`ignore-error=true`. If cache import or another cache-backed invocation failure
prevents a build, publication retries once through the same pinned build action
without either cache option. A missing, evicted, or unavailable cache can slow
a publication but cannot make cached state a correctness requirement.

The operational ceiling is **8 GiB** across all repository Actions caches,
leaving headroom below GitHub's 10 GiB repository allowance. npm caches should
normally remain below **2 GiB**, leaving up to **6 GiB** for the application
BuildKit scope. The publication summary records build duration, cache status,
entry count, and total usage after every build. Investigate usage above the
ceiling and remove stale entries with `gh cache list` and `gh cache delete`;
never delete an active cache solely to make a publication succeed.

The baseline recorded on 2026-08-18 was a 173-179 second image build and
9.69 GiB of npm caches, including 6.26 GiB attached to pull-request merge refs.
Compare later cold and warm publication summaries against that baseline. Keep
`mode=max` only while warm builds provide a material improvement (at least 30
seconds) and total cache usage remains within the ceiling; otherwise remove the
BuildKit import/export options rather than expanding the allowance.

Active-development deployments should use:

```sh
docker pull ghcr.io/rsocko/mission-control:latest
```

Use `sha-<7-character-commit>`, a semantic-version tag, or the full
`sha256` digest for rollback and release pinning.

## Repository configuration

Keep **Allow select actions and reusable workflows** configured with GitHub-owned
actions enabled, verified creator actions disabled, the single additional
pattern `docker/build-push-action@*`, and full-length commit SHA pinning
required. The pinned Docker build action exposes GitHub's cache runtime
credentials to BuildKit; raw inline `docker buildx build` commands do not.

Connect the GHCR package to this repository and set the package visibility to
**Public** so anonymous pulls work. Keep package write access inherited from the
repository; do not add personal access tokens or repository secrets. Validate a
published artifact with:

```sh
docker pull ghcr.io/rsocko/mission-control:latest
gh attestation verify \
  oci://ghcr.io/rsocko/mission-control@sha256:<digest> \
  --repo rsocko/mission-control
```
