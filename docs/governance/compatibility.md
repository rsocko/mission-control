# Compatibility Policy

Mission Control is pre-1.0. Until a 1.0 release establishes stable contracts,
minor releases may contain breaking changes.

## Supported versions

- The latest release and the default branch receive bug and security fixes.
- Older releases are not guaranteed to receive backports.
- Node.js 22 LTS is the supported development and runtime baseline.
- SQLite data must be backed up before an upgrade. Database migrations are
  forward-only unless a release note explicitly documents rollback support.

## Persisted SQLite origins

CI exercises frozen synthetic databases from three named migration origins:

- `0000_sweet_chameleon`, the oldest supported baseline;
- `0047_isolate_sync_worker`, the first durable sync-queue checkpoint; and
- `0104_quick_sort_undo`, immediately before the permanent GitHub NodeID
  cutover.

These checkpoints are supported upgrade origins, not a guarantee for arbitrary
hand-edited databases. Each fixture must reach every current migration hash and
preserve representative task, project, connector, sync, notification, setting,
and search behavior. A checkpoint may be retired only through an explicit
change to this policy and the release notes so operators can upgrade through a
supported intermediate release first.

## Public contracts

Breaking changes to documented APIs, MCP tools, connector contracts,
configuration variables, or deployment inputs must be called out in release
notes with migration instructions. Experimental and proposed documents do not
create compatibility guarantees.

Connector compatibility depends on supported upstream APIs. A connector may be
disabled when an upstream service removes a required API or when safe
authentication is no longer available.

## Deprecation

When practical, a public contract is deprecated for at least one minor release
before removal. Security fixes may require immediate removal or restriction of
unsafe behavior.
