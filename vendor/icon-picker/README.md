# `@rsocko/icon-picker`

A framework-neutral React icon picker with a portable string storage contract.
Choose and render emoji, Lucide, Material Design Icons, Phosphor, Dashboard
Icons, and Simple Icons without storing provider-specific objects.

> The first proposed release is `0.1.0-rc.0`. The package is not published
> until this repository's release setup and API have been reviewed.

## Live demo

The entirely static, client-side demo is deployed to
[rsocko.github.io/icon-picker](https://rsocko.github.io/icon-picker/). It
showcases the picker, portal trigger, renderer, every provider, portable values,
core utilities, network states, and keyboard behavior. It builds from repository
source and can deploy before the npm package is published.

The companion
[full-page explorer](https://rsocko.github.io/icon-picker/explorer/) provides a
dense icon-finder workspace with provider filters, copy formats, colors, sizes,
keyboard shortcuts, and live multi-provider search.

## Install

```sh
npm install @rsocko/icon-picker
```

React and React DOM 18.2 or newer are peer dependencies.

## Quick start

Import the package stylesheet once in your client application:

```tsx
import '@rsocko/icon-picker/styles.css';
import { IconPickerButton, IconRenderer } from '@rsocko/icon-picker';
import { useState } from 'react';

export function ProjectIcon() {
  const [icon, setIcon] = useState<string | null>('lucide:rocket');
  const [color, setColor] = useState('#3b82f6');

  return (
    <>
      <IconPickerButton
        value={icon}
        onChange={setIcon}
        color={color}
        onColorChange={setColor}
      />
      <IconRenderer value={icon} size={32} color={color} />
    </>
  );
}
```

The picker can also be embedded directly:

```tsx
import '@rsocko/icon-picker/styles.css';
import { IconPicker } from '@rsocko/icon-picker/picker';

<IconPicker value={icon} onChange={setIcon} />;
```

## Public API and bundle boundaries

The root export provides the complete public API:

- `IconPicker`
- `IconPickerButton`
- `IconRenderer`
- `parseIconValue`
- `serializeIconValue`
- `getIconUrl`
- `IconSource`, `ParsedIcon`, and all component prop types

Smaller subpath exports keep utility and renderer consumers away from the
picker's emoji search data and lazy emoji browser:

```ts
import {
  getIconUrl,
  getSimpleIconNames,
  parseIconValue,
  serializeIconValue,
  type IconSource,
  type ParsedIcon,
} from '@rsocko/icon-picker/core';

import {
  IconRenderer,
  type IconRendererProps,
} from '@rsocko/icon-picker/renderer';

import {
  IconPicker,
  IconPickerButton,
  type IconPickerProps,
  type IconPickerButtonProps,
} from '@rsocko/icon-picker/picker';
```

`@rsocko/icon-picker/core` has no React runtime import. The renderer subpath
does not load `emojilib` or `emoji-picker-react`. The full emoji browser uses
`React.lazy` and is requested only when a user chooses **Browse all**.

## Storage contract

Store only these strings:

| Source | Stored value | Example |
| --- | --- | --- |
| Emoji | Raw emoji | `🚀` |
| Lucide | `lucide:{name}` | `lucide:rocket` |
| Material Design Icons | `mdi:{name}` | `mdi:home` |
| Phosphor | `ph:{name}` | `ph:star` |
| Dashboard Icons | `dash:{name}` | `dash:nextcloud` |
| Simple Icons | `si:{name}` | `si:github` |

Legacy bare kebab-case names remain Lucide values:

```ts
parseIconValue('rocket');
// { source: 'lucide', name: 'rocket' }

serializeIconValue({ source: 'emoji', name: '🚀' });
// '🚀'
```

Unrecognized legacy text is preserved as raw text instead of being discarded.
Provider names are validated before a URL is constructed. Color values used in
URLs must be 3-, 4-, 6-, or 8-digit hexadecimal values, with an optional `#`;
invalid colors are ignored.

## Components

### `IconPickerButton`

The trigger opens a fixed-position portal, flips to stay in the viewport,
resizes to the available space (including narrow viewports), closes on outside
pointer input or Escape, restores trigger focus, and contains focus while its
dialog is open.

Important props:

| Prop | Type | Default |
| --- | --- | --- |
| `value` | `string \| null` | required |
| `onChange` | `(value: string) => void` | required |
| `onOpenChange` | `(open: boolean) => void` | — |
| `placeholder` | `ReactNode` | native emoji |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` |
| `disabled` | `boolean` | `false` |
| `color` | `string` | — |
| `pickerColor` | `string` | `color` |
| `onColorChange` | `(color: string) => void` | — |
| `label` | `string` | `'Pick an icon'` |
| `portalTarget` | `Element \| null` | `document.body` |
| `pickerProps` | picker presentation props | — |

### `IconPicker`

`IconPicker` supports source filtering, a local emoji keyword search, remote
Iconify search, provider catalog filtering, color selection, loading and empty
states, provider error notices, retries, keyboard activation, and an
`aria-live` result count. Iconify results are resolved in batched icon-set
requests, including aliases, then rendered as CSS masks so uncolored icons
inherit the consumer's current text color. Set `modal` only when embedding it
in your own modal surface; `IconPickerButton` does this automatically.

### `IconRenderer`

`IconRenderer` renders emoji as text, uncolored monochrome Iconify icons as
theme-aware CSS masks, and other provider icons as lazy `<img>` elements. It
rejects unsafe provider names, uses `no-referrer`, and renders `fallback` after
a network image error. Pass `label=""` for a decorative icon.

```tsx
<IconRenderer value="mdi:home" size={24} color="#10b981" />
<IconRenderer value={null} fallback={<span aria-hidden>—</span>} />
```

## Styling and theming

Import `@rsocko/icon-picker/styles.css`. The stylesheet is package-owned and
does not require Tailwind or Mission Control tokens. Override its variables in
your application:

```css
:root {
  --rs-icon-picker-bg: #111827;
  --rs-icon-picker-surface: #0f172a;
  --rs-icon-picker-surface-hover: #1e293b;
  --rs-icon-picker-border: #334155;
  --rs-icon-picker-text: #f8fafc;
  --rs-icon-picker-muted: #94a3b8;
  --rs-icon-picker-accent: #60a5fa;
  --rs-icon-picker-shadow: 0 20px 50px rgb(0 0 0 / 0.35);
}
```

## SSR and React Server Components

The utilities are server-safe. Component modules do not read `window` or
`document` during import or server render. Portal positioning and remote
catalog loading run only in effects. The full emoji browser is lazy and is
never loaded during the initial server render.

The components use state and effects. In frameworks with React Server
Components, import them from an application-owned client boundary rather than
relying on framework-specific directives in this package.

## Providers, network behavior, and CSP

Emoji search is local. The other providers use public network services:

| Purpose | Origin |
| --- | --- |
| Lucide, MDI, and Phosphor search/rendering | `https://api.iconify.design` |
| Dashboard Icons catalog/rendering | `https://cdn.jsdelivr.net` |
| Simple Icons catalog | `https://cdn.jsdelivr.net` |
| Simple Icons rendering | `https://cdn.simpleicons.org` |

A strict Content Security Policy generally needs:

```text
connect-src 'self' https://api.iconify.design https://cdn.jsdelivr.net;
img-src 'self' data: https://api.iconify.design https://cdn.jsdelivr.net https://cdn.simpleicons.org;
```

Add these origins only if they match your threat model. Host assets yourself or
do not use remote sources when an application cannot permit them. Search
failures are shown in the picker; built-in popular Dashboard/Simple icon lists
remain available. Renderer failures use the caller-provided fallback. The
package sends no credentials or user data, but search text is sent to Iconify
when a Lucide, MDI, or Phosphor search is active.

Catalog requests rely on the providers' browser CORS policies. `<img>` delivery
also depends on those remote services being available. Offline, native emoji,
parsing/serialization, and built-in popular lists continue to work, while
remote searches and SVGs may show their documented error or fallback states.

Provider and dependency license information is in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). Brand marks may remain
subject to trademark and brand-usage rules even when icon data is permissively
licensed.

## Migration from Mission Control's local component

The portable values and primary props are unchanged. Replace local imports and
remove aliases such as `EmojiPickerButton`:

```diff
- import { IconPickerButton as EmojiPickerButton, IconRenderer } from '@/components/ui/icon-picker';
+ import { IconPickerButton, IconRenderer } from '@rsocko/icon-picker';
+ import '@rsocko/icon-picker/styles.css';
```

No database migration is required. Existing raw emoji, prefixed values, and
bare Lucide names continue to render. Ensure the consumer's CSP permits the
origins above, then verify existing saved values, source search, color changes,
portal placement, and image failure fallbacks before deleting the local copy.

## Development and release preparation

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run demo:build
npm run demo:verify
npm run package:verify
npm run package:artifact
```

Run the demo locally with `npm run demo:dev`; Vite serves it at `/icon-picker/`
to match the production Pages subpath. `demo-dist/` is generated and ignored.
The npm package uses an explicit file allowlist, and package verification rejects
demo or workflow files if that boundary changes. Package verification performs
two real `npm pack` runs and requires byte-identical tarballs.

`npm run package:artifact` is intended for exact-commit downstream
synchronization. From a clean checkout it writes the tarball plus a
machine-readable `artifacts/UPSTREAM.json` containing the exact commit, optional
matching tag, package identity, complete file manifest, npm integrity, and
SHA-256/SHA-512 hashes. See [`docs/RELEASING.md`](./docs/RELEASING.md) for the
vendored-consumer and optional npm release procedures.

### GitHub Pages deployment

`.github/workflows/pages.yml` builds the static demo and deploys the
`demo-dist/` artifact using the official Pages actions. It uses read-only
repository access plus only `pages: write` and `id-token: write` for deployment.
No generated site, credentials, API keys, or npm package are involved.

After merging the workflow, an administrator may need to select **GitHub
Actions** under **Settings → Pages → Build and deployment → Source** once. Pushes
to `main` then deploy automatically, and `workflow_dispatch` supports a manual
retry. Deployment is independent of npm publication.

CI runs source, package, and static-demo checks and verifies the npm file
manifest. The release
workflow publishes only from a published GitHub release using npm trusted
publishing and provenance. Before enabling a release, configure
`@rsocko/icon-picker` on npm with:

- GitHub organization/user: `rsocko`
- Repository: `icon-picker`
- Workflow: `release.yml`
- Environment: `npm`

Then merge the reviewed release commit, tag the exact package version (for
example `v0.1.0-rc.0`), and publish the matching GitHub release. No npm token is
stored in this repository, and this branch does not publish anything.
Prereleases are published under npm's `next` distribution tag; only stable
versions receive `latest`.

## License

MIT © 2026 Ryan Sockalosky. See [`LICENSE`](./LICENSE).
