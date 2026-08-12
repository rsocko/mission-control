# Icon Picker

A universal icon picker component for React. Lets users search and select from **six icon sources** through a unified search-first interface.

## Icon Sources

| Source | Prefix | Description | Rendering |
|--------|--------|-------------|-----------|
| Emoji | *(raw character)* | Full emoji set with keyword search via `emojilib` | Text `<span>` |
| Lucide | `lucide:` | ~1,500 open-source icons | [Iconify CDN](https://api.iconify.design) |
| Material Design | `mdi:` | ~7,000 Material Design Icons | [Iconify CDN](https://api.iconify.design) |
| Phosphor | `ph:` | ~6,000 Phosphor Icons | [Iconify CDN](https://api.iconify.design) |
| Dashboard Icons | `dash:` | Self-hosted app logos (Plex, Nextcloud, etc.) | [jsDelivr CDN](https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons) |
| Simple Icons | `si:` | Brand/company logos (GitHub, Slack, etc.) | [Simple Icons CDN](https://cdn.simpleicons.org) |

## Quick Start

```tsx
import { IconPickerButton, IconRenderer } from '@/components/ui/icon-picker';

function MyComponent() {
  const [icon, setIcon] = useState<string | null>(null);
  const [color, setColor] = useState('#3b82f6');

  return (
    <div>
      {/* Button that opens the picker in a popover */}
      <IconPickerButton
        value={icon}
        onChange={setIcon}
        color={color}
        onColorChange={setColor}
      />

      {/* Render the selected icon anywhere */}
      <IconRenderer value={icon} size={32} color={color} />
    </div>
  );
}
```

## Components

### `<IconPickerButton>`

A trigger button that opens the full picker in a portal-based popover. This is the primary way to use the icon picker.

```tsx
<IconPickerButton
  value={icon}
  onChange={setIcon}
  size="md"
  placeholder={<Smile className="opacity-40" size={16} />}
  color="#3b82f6"
  onColorChange={setColor}
/>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `string \| null` | -- | Current icon value (required) |
| `onChange` | `(value: string) => void` | -- | Called when user picks an icon (required) |
| `onOpenChange` | `(open: boolean) => void` | -- | Called when picker opens/closes |
| `placeholder` | `ReactNode` | `😀` | Shown when no icon is selected |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | Button size |
| `className` | `string` | -- | Extra class on the trigger button |
| `disabled` | `boolean` | `false` | Disables the button |
| `color` | `string` | -- | Hex color for SVG icon tinting |
| `onColorChange` | `(color: string) => void` | -- | Called when user picks a color. If omitted, the color row is hidden. |

### `<IconPicker>`

The picker panel itself. Use this directly if you want to embed the picker inline rather than in a popover.

```tsx
<IconPicker
  value={icon}
  onChange={setIcon}
  onClose={() => setOpen(false)}
  color="#3b82f6"
  onColorChange={setColor}
/>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `string \| null` | -- | Current icon value |
| `onChange` | `(value: string) => void` | -- | Called when user picks an icon |
| `onClose` | `() => void` | -- | Called when the picker should close |
| `color` | `string` | -- | Hex color for SVG icon tinting |
| `onColorChange` | `(color: string) => void` | -- | Called when user picks a color |

### `<IconRenderer>`

Renders any stored icon value. Use this throughout your app to display icons chosen by the picker.

```tsx
<IconRenderer value="lucide:rocket" size={24} color="#3b82f6" />
<IconRenderer value="🚀" size={20} />
<IconRenderer value="dash:nextcloud" size={32} />
<IconRenderer value={null} fallback={<span>--</span>} />
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `value` | `string \| null \| undefined` | -- | The stored icon value |
| `size` | `number` | `20` | Icon size in pixels |
| `color` | `string` | -- | Hex color override for SVG icons |
| `className` | `string` | -- | Extra class on the wrapper |
| `fallback` | `ReactNode` | `null` | Shown when value is empty or icon fails to load |

## Storage Format

Icons are stored as simple strings, designed to fit in a `TEXT` database column:

| Type | Stored value | Example |
|------|-------------|---------|
| Emoji | Raw emoji character | `🚀` |
| Lucide | `lucide:{name}` | `lucide:rocket` |
| MDI | `mdi:{name}` | `mdi:home` |
| Phosphor | `ph:{name}` | `ph:star` |
| Dashboard | `dash:{name}` | `dash:nextcloud` |
| Simple Icons | `si:{name}` | `si:github` |

### Backward Compatibility

`parseIconValue()` handles legacy values gracefully:

- Raw emoji characters (e.g. `🚀`) are recognized automatically
- Bare kebab-case names without a prefix (e.g. `rocket`) are assumed to be Lucide icons

## Utility Functions

### `parseIconValue(value: string | null | undefined): ParsedIcon | null`

Parses a stored icon string into a `{ source, name }` object.

```ts
parseIconValue('lucide:rocket')  // { source: 'lucide', name: 'rocket' }
parseIconValue('🚀')             // { source: 'emoji', name: '🚀' }
parseIconValue('rocket')         // { source: 'lucide', name: 'rocket' } (backward compat)
parseIconValue(null)             // null
```

### `serializeIconValue(icon: ParsedIcon): string`

Converts a `ParsedIcon` back to a storage string.

```ts
serializeIconValue({ source: 'mdi', name: 'home' })  // 'mdi:home'
serializeIconValue({ source: 'emoji', name: '🚀' })  // '🚀'
```

### `getIconUrl(icon: ParsedIcon, color?: string): string | null`

Returns a CDN URL for rendering an icon. Returns `null` for emoji (rendered as text).

```ts
getIconUrl({ source: 'lucide', name: 'rocket' }, '#3b82f6')
// 'https://api.iconify.design/lucide/rocket.svg?color=%233b82f6'

getIconUrl({ source: 'dash', name: 'nextcloud' })
// 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/nextcloud.svg'
```

## Architecture

```
IconPickerButton (trigger + portal positioning)
  └── IconPicker (search, filters, results grid)
        ├── Emoji search (emojilib, local)
        ├── Lucide/MDI/Phosphor search (Iconify REST API)
        ├── Dashboard Icons search (local filter on cached catalog)
        ├── Simple Icons search (local filter on cached catalog)
        └── EmojiPicker (emoji-picker-react, for "Browse all" mode)

IconRenderer (standalone -- renders any stored value)
  ├── Emoji → <span> with text
  └── SVG icons → <img> with CDN URL
```

### Search Behavior

- **Default view**: Shows popular icons from each active source, grouped by source
- **Search**: All active sources are queried in parallel; results grouped by source
- **Source filter chips**: Optionally narrow to specific sources
- **Adaptive limits**: Fewer active sources = more results per source (24/32/48)

### External Dependencies

| Dependency | Purpose | Bundle impact |
|-----------|---------|---------------|
| `emojilib` | Emoji keyword dictionary | ~30 KB (data only) |
| `emoji-picker-react` | Full emoji browser widget | Lazy-loaded via `next/dynamic` |
| `lucide-react` | Only used for `Search`, `X`, `Loader2` UI icons in the picker itself | Already in the app |

### CDN Services Used (no API keys required)

- **Iconify API** (`api.iconify.design`) -- icon search + SVG rendering for Lucide/MDI/Phosphor
- **jsDelivr** (`cdn.jsdelivr.net`) -- Dashboard Icons catalog and SVGs
- **Simple Icons CDN** (`cdn.simpleicons.org`) -- brand icon SVGs
- **Simple Icons npm** (`cdn.jsdelivr.net/npm/simple-icons`) -- icon catalog JSON

## Demo

A demo page is available at `/demo/icon-picker` when running the dev server. It shows all component variants and sizes.
