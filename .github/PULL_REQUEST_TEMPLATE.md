## Summary

<!-- Explain the user-visible or operational outcome and link the issue. -->

Closes #

## Changes

<!-- Call out data model, API, connector, security, or migration changes. -->

## Validation

<!-- List the exact commands and any manual checks performed. -->

## Security and privacy

- [ ] This change does not commit credentials, tokens, personal data, production
      exports, private infrastructure details, or real connector payloads.
- [ ] New or changed workflows use least-privilege permissions, immutable action
      references, and no protected secrets for untrusted pull requests.
- [ ] Connector changes document collected data, retention, write-back behavior,
      and deletion expectations.
- [ ] Logs, fixtures, screenshots, and examples use synthetic values.

## Contributor checklist

- [ ] I added or updated tests for changed behavior.
- [ ] I updated relevant documentation and compatibility notes.
- [ ] I included migration and rollback steps for persistent data changes.
- [ ] I confirmed `package.json` remains private unless npm publication was
      separately approved.
