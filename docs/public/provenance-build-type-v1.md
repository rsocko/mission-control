# Mission Control container publication build type v1

This document defines the build type used by the SLSA v1 provenance predicate
for Mission Control container images.

## External parameters

`source` identifies the only source tree used by the build:

- `uri` is the repository Git URI with `refs/heads/main`.
- `digest.gitCommit` is a full lowercase commit SHA that the workflow verified
  as an ancestor of `origin/main` before and after checkout.

`trigger` is either `workflow_run` for automatic publication after a successful
same-repository `CI` push on `main`, or `workflow_dispatch` for a manual request
whose explicit commit SHA passed the same ancestry checks.

## Internal parameters

`internalParameters` is an empty object. The build receives no hidden source
selection parameters.

## Resolved dependencies

`resolvedDependencies` contains exactly the verified source URI and commit from
`externalParameters.source`.

## Run details

`builder.id` identifies `.github/workflows/publish-container.yml` on
`refs/heads/main`. `metadata.invocationId` is the immutable GitHub Actions run
attempt URL.
