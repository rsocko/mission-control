/**
 * `@/lib/triage` compatibility barrel.
 *
 * This file is intentionally implementation-free: it only re-exports the
 * public API of the split triage domain modules so existing imports of
 * `@/lib/triage` keep working. New code — and any consumer that only needs
 * one slice of triage functionality — should import directly from the
 * relevant domain module instead, so bundlers/runtimes don't pull in
 * unrelated wiring (e.g. query-only consumers shouldn't pull in the action
 * provider integrations wired up in `./actions`):
 *
 *   - `./capture`        — ingest paths (URL/image/text capture, bulk import, embeds)
 *   - `./query`          — read-only listing/lookup/validation
 *   - `./actions`        — applying/undoing actions, task-creation reservation
 *   - `./classification` — content-type detection and overrides
 *   - `./lifecycle`      — deletion, retention purge, sample-data administration
 */
export * from './capture';
export * from './query';
export * from './actions';
export * from './classification';
export * from './lifecycle';
