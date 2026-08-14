---
name: Mission Control
description: Personal task and alert aggregation command center
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
  text-tertiary: "#8b9ab5"
  text-muted: "#8190a6"
  accent: "#3b82f6"
  accent-soft: "#60a5fa"
  accent-action: "#2563eb"
  accent-muted: "#1e3a8a"
  success: "#10b981"
  success-muted: "#065f46"
  warning: "#f59e0b"
  warning-muted: "#92400e"
  danger: "#ef4444"
  danger-muted: "#991b1b"
  info: "#06b6d4"
  info-muted: "#155e75"
  source-todo: "#3b82f6"
  source-github: "#a855f7"
  source-calendar: "#f59e0b"
  source-email: "#10b981"
  source-custom: "#64748b"
typography:
  heading:
    fontFamily: "Geist Sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Geist Sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
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
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  10: "40px"
  12: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent-action}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
  button-secondary:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  card:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "20px"
  input:
    backgroundColor: "{colors.surface-0}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  badge:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
---

# Design System: Mission Control

## Overview

**Creative North Star: "The Operational Command Center"**

Mission Control is a dark-first hybrid workspace: a dense desktop operational command center and a guided mobile action surface. Its visual hierarchy comes from disciplined slate surfaces, quiet borders, compact type, and small semantic signals rather than decorative effects. Desktop preserves broad scanability; mobile deliberately sequences the most urgent work before summary and secondary navigation.

Blue identifies action, selection, focus, and progress. Other hues carry explicit status, priority, source, or project meaning. Compact summaries, empty states, and notices reduce vertical occupation without removing labels or actions. Assessment surfaces favor solid semantic fills and restrained tonal backgrounds; purple-to-indigo decoration is not part of the operational container language.

**Key Characteristics:**
- Dense desktop command center paired with a guided, action-first mobile sequence
- Solid tonal surfaces separated by quiet full borders
- Semantic color expressed through text, badges, progress fills, border tints, and dots
- Compact shared summaries, notices, and empty states that return space to live work
- Fast state transitions with stronger motion reserved for direct manipulation
- Responsive shell that swaps the desktop rail for mobile header and bottom navigation

## Colors

The palette is a cool slate stack with one blue action voice and a small set of semantic and provenance hues.

### Primary
- **Action Blue** (`accent-action`, `accent`, `accent-soft`): primary buttons step from the deeper action fill to blue on hover; the core accent also marks focus, active navigation, links, and progress.
- **Deep Blue Tint** (`accent-muted`): low-emphasis selected or focus-related backgrounds, always paired with readable text or an icon.

### Secondary
- **Semantic Green, Amber, Red, and Cyan** (`success`, `warning`, `danger`, `info`): outcomes and state categories. Muted companions provide low-chroma background fields while text, labels, or icons preserve meaning.
- **Connector Hues** (`source-todo`, `source-github`, `source-calendar`, `source-email`, `source-custom`): provenance only. They may color a connector icon or small indicator but do not define whole panels.

### Neutral
- **Canvas** (`background`): application ground.
- **Chrome** (`surface-0`): deepest panels, toolbars, and input wells.
- **Panel** (`surface-1`): cards, rail, and primary content containers.
- **Raised** (`surface-2`): hover, active navigation, dropdown, and nested content surfaces.
- **Pressed** (`surface-3`): strongest neutral state and progress tracks.
- **Quiet Stroke** (`border-subtle`, `border`, `border-strong`): separators, standard container outlines, and elevated/focus-adjacent outlines.
- **Primary, Secondary, Tertiary, and Muted Text** (`text-primary`, `text-secondary`, `text-tertiary`, `text-muted`): descending emphasis; tertiary and muted values are intentionally lifted enough to remain legible on shipped surfaces.

### Named Rules

**The Solid Signal Rule.** Operational cards, recommendations, schedule blocks, insights, and progress bars use a solid neutral or semantic fill. Do not use purple/indigo gradients to manufacture importance.

**The Semantic Evidence Rule.** Color must correspond to an action, state, priority, project, or source and must be reinforced by text, iconography, or position.

## Typography

**Display Font:** Geist Sans with system sans fallbacks

**Body Font:** Geist Sans with system sans fallbacks

**Label/Mono Font:** Geist Mono for IDs, times, shortcuts, routes, and tabular operational values

**Character:** One compact sans family keeps the interface neutral and scannable. Mono is a functional contrast, not a decorative voice.

### Hierarchy
- **Page heading** (600, 20px, 1.2): page titles and the strongest section headings.
- **Card title** (600, 16px): card and panel titles.
- **Section label** (600, 14px): sidebar groups and dense section headings.
- **Body** (400, 14px, 1.5): task text, descriptions, and controls.
- **Label** (500, 12px, 1.4): metadata, badges, button labels, and secondary information.
- **Caption** (400, 9–11px): timestamps, counts, and tertiary operational metadata.

Headings use slightly tightened tracking; compact labels sometimes use modest positive tracking and uppercase where they denote a state or group. Dynamic counters, durations, times, and progress values use tabular numerals.

### Named Rules

**The One-Family Rule.** Build hierarchy with Geist size, weight, color, and spacing; do not introduce a display face.

## Layout

The desktop shell uses a collapsible navigation rail: 64px collapsed and 200px expanded. A toolbar divides search, a centered quick-add field capped at 672px, and right-aligned actions. The dashboard's KPI summary is one bordered, collapsible bar: a 40px header above 56px inline metric cells separated by one-pixel dividers, with horizontal overflow rather than a grid of hero cards. Empty task containers stop claiming the remaining viewport, and an empty notifications panel yields to its collapsed rail. Content surfaces use compact 4px-based spacing, most often 8, 12, 16, 20, and 24px.

At the 640px boundary, the desktop rail and toolbar give way to mobile chrome. Mobile uses a header and fixed bottom navigation, safe-area insets, full-width content, and touch-sized primary actions. The shipped dashboard orders Needs Attention first, then a compact Today status summary, a horizontally scrolling Go To action strip, and recent completions. Capture remains elevated in the fixed bottom navigation. Wider views add columns progressively; recurring two-column regions appear at the large breakpoint.

**The Dense Rhythm Rule.** Whitespace separates groups and establishes scan order; it is not decorative. Prefer the established 4px rhythm and avoid oversized empty bands.

**The Context-Adaptive Density Rule.** Preserve simultaneous scan breadth on desktop; on mobile, spend the first viewport on immediate action and defer status and navigation behind it.

## Elevation & Depth

Depth is hybrid but surface-led. Most hierarchy comes from canvas, chrome, panel, raised, and pressed tonal steps plus one-pixel borders. Shadows are restrained on static cards and become stronger for dropdowns, tooltips, modals, dragged schedule blocks, and other genuinely floating elements. The blue glow belongs to text-entry focus, not content emphasis.

### Shadow Vocabulary
- **Low** (`--shadow-sm`): subtle separation for cards and standard controls.
- **Elevated** (`--shadow-md`): dropdowns and temporarily lifted content.
- **Floating** (`--shadow-lg`): popovers, tooltips, modals, and overlays.
- **Focus glow** (`--shadow-focus-glow`): globally applied to focused text fields and `.input-glow` wrappers.

### Named Rules

**The Surface-First Rule.** Establish hierarchy with tonal surfaces and quiet borders before adding shadow.

**The Focus-Is-Input Rule.** The accent glow communicates text entry. Buttons use visible focus rings; selected rows use contained rings or surface changes.

## Shapes

Corners are gently rounded and consistent: 6px for compact controls, 8px for standard controls and rows, 12px for cards and panels, 16px for larger sheets, and a full pill for badges, status dots, avatars, and progress tracks.

Containers use a quiet one-pixel full border when tonal separation alone is insufficient. Semantic assessment panels tint the complete border rather than attaching a thick colored side stripe. Small colored dots are preferred when a project or phase hue is provenance rather than container state. The 3px active marker on the navigation rail remains a navigation-specific locator, not a general card treatment.

**The Complete Container Rule.** Status and assessment containers use a full neutral or semantic border. Reserve unilateral bars for native navigation location or quoted content.

## Components

### Buttons
- **Shape:** standard controls use the medium radius (8px) and 36px height; small and large variants use 6px and 12px corners.
- **Primary:** solid action-blue fill, white text, 8px × 16px padding, and a low shadow.
- **Secondary / Outline / Ghost:** neutral raised fill, a quiet full border, or no resting container; hover steps toward the next neutral surface.
- **Hover / Focus / Press:** color changes in 150ms, a two-pixel blue focus ring, and a subtle `0.96` press scale.
- **Destructive:** solid danger fill with white text.

### Badges
- **Style:** full pills with a one-pixel border, 2px × 8px padding, and 12px medium text.
- **State:** neutral badges use raised slate; semantic variants combine a muted solid field, semantic text, and a faint border. Labels, not color alone, name the state.

### Cards / Containers
- **Corner Style:** panel radius (12px).
- **Background:** panel surface by default; raised surface for nested or interactive regions.
- **Shadow Strategy:** low at rest, stronger only when floating or being directly manipulated.
- **Border:** one-pixel quiet full border. Semantic containers may tint the full border at low opacity.
- **Internal Padding:** 16–20px for most cards; 12px for dense nested blocks.
- **Empty state:** compact in-place states use 20–24px vertical padding, a 24px Lucide status icon when an icon adds meaning, one short title, and at most one explanatory line or recovery action. Empty containers shrink instead of filling available height.

### Inputs / Fields
- **Style:** chrome background, one-pixel border, 8px radius, and 8px × 12px padding.
- **Focus:** the global border shift and focus glow apply to text inputs and textareas. Wrappers around a bare input use `.input-glow`.
- **Embedded controls:** icons and clear actions stay tertiary until hover; the input itself remains borderless inside a focused wrapper.

### Navigation
- **Desktop:** a 64px rail expands to 200px. Items are 40px high with 8px corners; hover and active states use the raised surface. Active items retain a narrow blue locator and brighter icon/text.
- **Mobile:** a fixed five-item bottom bar replaces the rail below 640px; Capture is elevated as the primary mobile action. Live counts use labeled red or amber badges.
- **Mobile action strip:** secondary destinations use a horizontal overflow row with 44px minimum-height links, 8px corners, 15px Lucide icons, and 12px labels.
- **Icons:** Lucide is the default interface family; custom product/source marks are allowed where they carry product or provenance meaning.

### Compact KPI Bar
- A 40px collapsible header and 56px inline metrics share one 12px-radius bordered container; individual metrics do not become separate cards.
- Each metric pairs a 28px semantic icon well with a 12px label and 16px semibold tabular value. Dividers, not gutters, establish the desktop scan rhythm.
- The metric row maintains a 560px minimum width and scrolls horizontally when space is constrained. Interactive metrics use the raised surface on hover.

### Demo and Empty-State Feedback
- Demo mode is a minimum-40px amber notice row with a 14px Lucide flask, truncated explanatory copy, and a compact 32px action. It stays informative without becoming a second toolbar.
- Empty notification results use the same compact in-place pattern as task and queue empties. When the notification source itself has no items, the desktop panel automatically returns to the collapsed rail rather than displaying an empty 360px column.

### Progress and Semantic Panels
- Progress tracks use a solid pressed-surface track and one solid fill selected from project, accent, or semantic data.
- Phase/project color appears as a compact dot or solid progress fill.
- Recommendations, day-plan blocks, routine insights, and timeline blocks use neutral or lightly tinted solid surfaces with complete borders; their labels and icons explain the semantic hue.

## Do's and Don'ts

### Do:
- **Do** use solid surface steps and quiet complete borders for operational hierarchy.
- **Do** use dots, text, icons, and solid progress fills for project, phase, source, priority, and health signals.
- **Do** keep common state transitions at 100–150ms and reserve 300–500ms movement for shell expansion, progress interpolation, and direct manipulation.
- **Do** use skeletons for content loading and visible focus treatment for keyboard interaction.
- **Do** preserve compact spacing and at least 40px touch targets in mobile navigation and high-frequency actions.
- **Do** collapse or shrink empty operational regions so the remaining live work keeps viewport priority.
- **Do** put urgent mobile actions before status summaries and secondary destinations.

### Don't:
- **Don't** use purple/indigo or multicolor gradients as generic emphasis on cards, assessment panels, schedule blocks, or data bars.
- **Don't** use thick left borders or inset side stripes on ordinary content containers; use a full border or a small semantic dot.
- **Don't** use the blue accent decoratively or let connector hues take over a panel.
- **Don't** add shadows where a surface step and border already establish hierarchy.
- **Don't** add a second icon library or a decorative display typeface.
- **Don't** exceed 300ms for ordinary state feedback.
- **Don't** turn desktop KPI summaries into oversized standalone metric cards.
- **Don't** let a mobile status summary or destination menu outrank Needs Attention.
