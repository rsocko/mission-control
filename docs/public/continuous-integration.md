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

Container publication intentionally does not use a BuildKit GitHub Actions
cache. If caching is reconsidered, use the application-only scope
`mission-control-app-v1` and reserve `mission-control-copilot-adapter-v1` for a
future Copilot Adapter image; the two images must never share a scope.

Repository Actions cache usage should remain below **8 GiB**, leaving headroom
below GitHub's 10 GiB repository allowance. The main-only npm cache should
normally remain below **2 GiB**. Investigate usage above the ceiling and remove
stale entries with `gh cache list` and `gh cache delete`.

The pre-change baseline recorded on 2026-08-18 was a 173-179 second image build
and 9.69 GiB of npm caches, including 6.26 GiB attached to pull-request merge
refs. A `mode=max` experiment took 387 seconds for the initial export. Rebuilding
the identical commit took 109 seconds, but a realistic subsequent commit took
243 seconds: only two early layers were reused and cache export itself consumed
54 seconds. Although the experiment stayed under the cache ceiling at 2.30 GiB,
it failed the 30-second material-improvement threshold for normal publications.
The BuildKit cache was therefore removed; cold-build correctness remains the
only publication path.

Active-development deployments should use:

```sh
docker pull ghcr.io/rsocko/mission-control:latest
```

Use `sha-<7-character-commit>`, a semantic-version tag, or the full
`sha256` digest for rollback and release pinning.

## Repository configuration

Keep **Allow select actions and reusable workflows** configured with GitHub-owned
actions enabled, verified creator actions disabled, no additional patterns, and
full-length commit SHA pinning required. Publication uses native Docker commands
rather than Docker-maintained actions.

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
