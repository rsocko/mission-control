---
name: Mission Control
description: Personal task & alert aggregation command center
colors:
  background: "#020617"
  surface-0: "#0b1120"
  surface-1: "#111827"
  surface-2: "#1e293b"
  surface-3: "#334155"
  border: "#1e293b"
  border-subtle: "#162032"
  border-strong: "#334155"
  text-primary: "#f8fafc"
  text-secondary: "#94a3b8"
  text-tertiary: "#64748b"
  accent: "#3b82f6"
  accent-hover: "#60a5fa"
  accent-muted: "#1e3a8a"
  success: "#10b981"
  warning: "#f59e0b"
  danger: "#ef4444"
  info: "#06b6d4"
  source-todo: "#3b82f6"
  source-github: "#a855f7"
  source-calendar: "#f59e0b"
  source-email: "#10b981"
typography:
  body:
    fontFamily: "Geist Sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  heading:
    fontFamily: "Geist Sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  label:
    fontFamily: "Geist Sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.01em"
  mono:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  card:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "16px"
  tag-pill:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
---

## Overview

Mission Control is a dark-first personal command center that aggregates tasks, alerts, and projects from multiple source systems (Microsoft Todo, GitHub, future connectors). The visual language is dense and information-rich — inspired by Linear and Raycast — with minimal chrome and maximum signal.

The interface uses a single font family (Geist Sans) at tight size ratios, blue accent for primary actions, and layered dark surfaces for depth hierarchy. Motion is fast (100–300ms) and purposeful: state changes and reveals only.

## Colors

Dark-first with a blue-undertone neutral scale (Slate family). Three surface layers create depth without borders:

- **Surface-0** (`#0b1120`): deepest background, page-level
- **Surface-1** (`#111827`): card and panel backgrounds
- **Surface-2** (`#1e293b`): elevated elements, dropdowns, hover states
- **Surface-3** (`#334155`): active/pressed states

**Accent** is a standard blue (`#3b82f6`) used sparingly: primary buttons, active nav items, focus rings, and progress indicators. Never decorative.

**Semantic colors** are fixed and not themed: success (emerald), warning (amber), danger (red), info (cyan). Each has a muted variant for dark backgrounds.

**Source connectors** have assigned brand colors for instant recognition: Todo=blue, GitHub=purple, Calendar=amber, Email=emerald.

## Typography

Single family: **Geist Sans** (with Geist Mono for code/IDs). No display font. Scale is tight (1.125 ratio) to support dense information layouts:

| Role | Size | Weight | Use |
|------|------|--------|-----|
| Page heading | 20px | 600 | Page titles, section headers |
| Section label | 14px | 600 | Sidebar groups, card titles |
| Body | 14px | 400 | Task text, descriptions, most content |
| Label | 12px | 500 | Metadata, badges, secondary info |
| Caption | 11px | 400 | Timestamps, counts, tertiary info |

Letter-spacing: headings get `-0.02em`, labels get `+0.01em`, body is normal.

Font smoothing: antialiased globally. Tabular numbers (`font-variant-numeric: tabular-nums`) on all dynamic counters and progress values.

## Elevation

Elevation is expressed through **surface color stepping** rather than shadows. Shadows exist but are subtle and used for floating elements only:

| Level | Surface | Shadow | Use |
|-------|---------|--------|-----|
| Ground | surface-0 | none | Page background |
| Card | surface-1 | shadow-sm | Cards, sidebar panels |
| Elevated | surface-2 | shadow-md | Dropdowns, popovers, modals |
| Floating | surface-3 | shadow-lg | Tooltips, toasts |

A glow shadow (`0 0 20px rgba(59, 130, 246, 0.15)`) is reserved for focus states and active elements.

### Focus Glow

Text-entry inputs receive a subtle accent glow on focus. This is handled globally in `globals.css` — individual inputs should **not** add their own `focus:border-*` or `focus:ring-*` classes.

| Token | Value | Use |
|-------|-------|-----|
| `--shadow-focus-glow` | `0 0 12px -2px var(--accent), 0 0 4px -1px var(--accent)` | Box-shadow on focused text inputs |
| `--border-focus` | `color-mix(in srgb, var(--accent) 40%, transparent)` | Border color on focused text inputs |

**Where glow applies:**
- `<input>` (text, email, password, search, url, tel, number) — automatic via global CSS
- `<textarea>` — automatic via global CSS
- Wrapper divs around a bare input (e.g. `SearchInput`) — add class `input-glow` for `focus-within` glow
- The QuickAddBar — uses the same tokens via JS-toggled classes

**Where glow does NOT apply:**
- Navigation active state (NavRail) — uses accent bar + tinted background
- Selected task rows — use `ring-1 ring-inset` (transient selection, not input focus)
- Toggle switches, checkboxes, radio buttons — not text-entry surfaces
- Buttons — use `focus-visible:ring-*` outline instead

## Components

### Buttons
- **Primary**: blue accent fill, white text, `8px` radius, `8px 16px` padding
- **Secondary/Ghost**: transparent, text-secondary color, border on hover
- **Destructive**: danger fill, white text
- All: 150ms transition on background-color only. Scale `0.96` on press.

### Cards
- Surface-1 background, `12px` radius, `1px` border (border-subtle)
- `16px` padding, `shadow-sm`
- Hover: border transitions to border-strong (150ms)

### Tag pills
- Surface-2 background, full radius, `4px 10px` padding
- 12px font, 500 weight, text-secondary
- Active/selected: accent background, white text

### Task rows
- No card wrapper — flat list items with `12px` vertical padding
- Hover: surface-2 background (100ms)
- Checkbox: 18×18, rounded-sm, accent fill on complete with checkmark animation

### Navigation
- Sidebar: surface-0 background, 240px width
- Active item: surface-2 background + accent-colored left indicator (2px)
- Icons: 16px Lucide, text-tertiary default, text-primary when active

### Forms
- Input: surface-1 background, border, `8px` radius, `8px 12px` padding
- Focus: accent border + glow shadow (applied automatically via global CSS — do not add `focus:border-*` or `focus:ring-*` to text inputs)
- Wrapper inputs (input inside a styled div): add class `input-glow` to the wrapper for `focus-within` glow
- Labels: 12px, 500 weight, text-secondary, `4px` gap above input

## Do's and Don'ts

### Do
- Use surface stepping for hierarchy (surface-0 → 1 → 2 → 3)
- Keep transitions to 100–150ms for interactive states
- Use accent blue only for actionable/active elements
- Show source connector icons (16px) as subtle provenance indicators
- Use skeleton loading states for async content
- Maintain 40×40px minimum tap targets (extend with pseudo-elements if needed)

### Don't
- Don't use accent color decoratively (no blue stripes, no gradient fills)
- Don't add motion on page load (content should render immediately)
- Don't mix icon libraries (Lucide only, via Iconify when available)
- Don't use borders where a surface-step would suffice
- Don't show loading spinners in content areas (use skeletons)
- Don't use shadows as the primary depth mechanism (surfaces first)
- Don't exceed 300ms on any transition (users are in flow)
