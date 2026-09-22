# Contributing to Mission Control

Thank you for helping improve Mission Control.

## Before contributing

- Search existing issues and pull requests before opening a new one.
- Use the issue forms for bugs and feature proposals.
- Report vulnerabilities through the private process in
  [SECURITY.md](SECURITY.md), never in a public issue.
- Do not include real credentials, personal data, connector exports, production
  logs, private hostnames, or infrastructure details.

## Development workflow

1. Create a branch from `main`.
2. Install dependencies with `npm install`.
3. Copy `.env.example` to `.env.local` and use only local or synthetic values.
4. Make a focused change with tests and documentation.
5. Run the relevant tests and `npm run lint`.
6. Open a pull request and complete its security and privacy checklist.

See the [public development guide](docs/public/development.md) for repository
layout, commands, and test expectations.

## Pull requests

Keep pull requests small enough to review. Explain behavior changes, persistent
data migrations, compatibility impact, and rollback steps. Maintainers may ask
for additional threat-model, privacy, or accessibility review.

When a change materially alters a persisted SQLite shape, migration safety net,
or cutover contract, update or add a checkpoint in
`tests/fixtures/persisted-state/manifest.ts`, regenerate the frozen synthetic
databases with `npm run db:fixtures:persisted-state`, and run
`npm run test:persisted-state`. Retiring a checkpoint requires an intentional
compatibility-policy and release-note change. Fixtures must contain only
deterministic synthetic values: never copy a production database, connector
identifier, credential, webhook secret, repository identity, or personal task
content.

All changes require review. Security-sensitive paths use CODEOWNERS. Do not
attempt to bypass required checks, conversation resolution, or branch rules.

## Licensing gate

The project does not yet have an approved public license. Until an explicit
legal/IP decision adds a `LICENSE` file, no license is granted to copy,
redistribute, or create derivative works, and maintainers must not merge
external contributions. See [licensing status](docs/governance/licensing.md).

By submitting a contribution, you confirm that you have the right to submit it
and that it contains no confidential or third-party material you cannot share.
