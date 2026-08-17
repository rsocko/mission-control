# Impeccable Design Review

Mission Control vendors the GitHub Copilot build of
[Impeccable](https://github.com/pbakaus/impeccable) Skill 4.1.1 under
`.github/skills/impeccable`. The shared hook in
`.github/hooks/impeccable.json` runs its deterministic detector after direct UI
edits in Copilot CLI and the Copilot cloud agent.

The hook reads the edited UI source and the project design context in
`PRODUCT.md`, `DESIGN.md`, and `.impeccable/config.json`. It does not require an
API key. The detector runs locally; live mode starts a development-only helper
on localhost and may fetch page assets while capturing a preview. Do not use
live mode against production data or pages containing sensitive information.
Generated sessions, previews, screenshots, caches, local consent, and local
overrides remain ignored by `.gitignore`.

The committed policy enables design-system checks, excludes advisory-only
findings, limits each hook response to five findings and 4,000 characters, and
silences clean-file acknowledgements. To opt out for the repository, run:

```bash
node .github/skills/impeccable/scripts/hook-admin.mjs off
```

To keep a personal override instead, set `hook.enabled` to `false` in the
gitignored `.impeccable/config.local.json`. Environment overrides documented by
the skill are also available for a one-shot run.

Run explicit checks with:

```bash
npm run impeccable:validate
npm run impeccable:audit
node .github/skills/impeccable/scripts/detect.mjs --json src
```

In Copilot, `/impeccable audit <target>` performs the broader accessibility,
responsive-layout, performance, and UI-quality review. `/impeccable live`
provides browser-assisted iteration. Live mode injects only into
`src/app/layout.tsx` before `</body>`; the current application CSP does not
apply to that route, and the helper must remain development-only.

The initial restoration assessment and prioritized follow-up areas are recorded
in [Impeccable baseline assessment](impeccable-assessment.md).

Update the vendored payload with the reviewed upstream release rather than
editing generated skill files in place. After an update, refresh the version
assertion and provenance in `scripts/validate-impeccable.mjs` and
`.github/skills/impeccable/THIRD_PARTY_NOTICES.md`, then run the validation and
audit commands.
