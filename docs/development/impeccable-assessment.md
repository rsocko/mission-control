# Impeccable Baseline Assessment

Assessment date: 2026-08-14

The Impeccable 4.1.1 detector scanned `src` with the committed `DESIGN.md`
context. A rendered desktop smoke check used synthetic local data at
1280x800. The source scan returned 488 findings: 19 warnings and 469 advisory
design-system findings.

## Priority findings

1. **Root-page hydration mismatch.** The rendered desktop check reports that
   `QuickAddBar` renders a connector badge on the server and a voice-input
   button on the client. React discards and regenerates that subtree. Stabilize
   the server/client capability decision before relying on further visual
   measurements for the toolbar.
2. **Design context has drifted.** Impeccable Doctor reports that `PRODUCT.md`
   uses the pre-v4 schema and that 26 commits have touched `src` or `public`
   since `DESIGN.md` was last updated. Run `/impeccable init` as an
   owner-guided interview, then `/impeccable document` after reviewing the
   current tokens and components.
3. **The documented token inventory is incomplete or inconsistently applied.**
   The detector found 370 font-size, 97 color, and 2 radius advisories outside
   `DESIGN.md`. The highest concentrations are `TagReviewPanel`,
   `SearchCommand`, `IdeationCanvas`, `PortfolioVisuals`, and `UniverseGraph`.
   Review those surfaces first and either replace literals with established
   tokens or deliberately extend the documented scale.
4. **Six AI-style gradient findings appear to be real design drift.** They
   occur in `MobileProjectsView`, `SmartScoreBadge`, `TodayMainPanel`, and
   `TodaySidebar`. These purple/indigo gradients conflict with the product's
   explicit anti-reference for generic SaaS gradients and should be redesigned
   with semantic colors or surface stepping.
5. **Seven left-border findings need product review.** Several are semantic
   timeline or insight indicators, while others wrap AI summaries. Preserve
   indicators that convey real state, but remove decorative card-edge stripes
   where color has no additional meaning.

## Detector findings that are not current defects

- The `broken-image` warning points to the raw `<img>` sanitization regular
  expression in `TaskDetailPanel`, not a rendered image.
- The `bounce-easing` warning points to the reduced-motion rule that disables
  `animate-bounce`.
- Three connector `gray-on-color` warnings cross-match opposite branches of a
  conditional class expression. The inactive zinc text is not rendered on the
  active green background.
- The Word Insights `gray-on-color` warning cross-matches the active and
  inactive branches of its mode toggle.

These should remain visible until upstream detection can distinguish regex
literals and conditional class branches; broad project ignores would also hide
real future regressions.

## Follow-up coverage

After the hydration mismatch is fixed, repeat rendered checks at 1280x800 and
390x844 with seeded synthetic data. The follow-up should measure computed
contrast, horizontal overflow, clipped text, keyboard focus order, accessible
names, and 40x40 mobile targets. Source analysis alone cannot prove those
runtime properties.
