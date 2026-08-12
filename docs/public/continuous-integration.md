# Continuous integration and container publication

The public repository uses only GitHub-hosted `ubuntu-24.04` runners. Pull
requests and pushes to `main` install the locked dependencies, validate workflow
policy, lint, run unit tests, smoke-test the worker runtime, and build the
production application. Fork pull requests use a read-only `GITHUB_TOKEN`,
receive no protected secrets, and cannot publish a container.

Container publication runs only after a push to `main` or a maintainer-triggered
manual dispatch. It pushes the image without a mutable tag, records the
resulting `sha256` digest, attaches a BuildKit-generated SBOM, and publishes
GitHub build provenance for that digest. Consumers should deploy
`ghcr.io/<owner>/<repository>@sha256:<digest>`, never a mutable tag.

## Repository configuration

No Actions allowlist change is required. Keep **Allow select actions and
reusable workflows** configured with GitHub-owned actions enabled, verified
creator actions disabled, no additional patterns, and full-length commit SHA
pinning required. The workflows intentionally use native Docker commands rather
than Docker-maintained actions.

After the first successful publication, connect the GHCR package to this
repository and set the package visibility to **Public** so anonymous digest
pulls work. Keep package write access inherited from the repository; do not add
personal access tokens or repository secrets. Validate the published artifact
with:

```sh
docker pull ghcr.io/<owner>/<repository>@sha256:<digest>
gh attestation verify \
  oci://ghcr.io/<owner>/<repository>@sha256:<digest> \
  --repo <owner>/<repository>
```
