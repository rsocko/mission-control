# Release and Versioning Policy

Mission Control uses semantic versioning tags in the form `vMAJOR.MINOR.PATCH`.
Before 1.0, a minor version may contain a breaking change and must document it.

## Release requirements

A release must:

1. originate from a reviewed commit on the protected default branch;
2. pass the approved required checks;
3. use a protected release tag;
4. generate release notes that identify changes, migrations, compatibility
   impact, known risks, and rollback limits;
5. publish artifacts only through an approved least-privilege workflow; and
6. attach an SBOM and provenance when the artifact pipeline supports them.

Release workflows must use immutable action references. Publishing jobs must not
run for untrusted pull requests or expose protected environments or secrets.

Container releases use immutable digests. Mutable convenience tags, if
published, are not sufficient for deployment pinning.

## Package status

`package.json` remains `"private": true`. npm publication requires a separate
approval that defines package ownership, naming, licensing, provenance, and
support obligations.
