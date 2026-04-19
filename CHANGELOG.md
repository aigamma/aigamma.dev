# Changelog

## 1.1.2 — 2026-04-19 — Overnight Alignment metric + mobile-friendly labs

This is the first semver-tagged release of aigamma.com. The existing
history up to this point is the dated entries below; going forward the
`package.json` `version` field will be the source of truth for what is
deployed, and entries under a version heading describe the changes that
shipped in that version.

Two user-visible changes ship together in 1.1.2:

**Overnight Alignment replaces IV Percentile in the dashboard header
row.** The new stat sits where IV Percentile used to sit in
`src/components/LevelsPanel.jsx` (the middle row of the levels card, third
column). It compares today's Put Wall, Vol Flip, and Call Wall against
the prior trading day's final values and reports the net agreement as a
signed score in `[-3, +3]`: +3 means all three levels rose, -3 means all
three fell, 0 means a wash, and the partial values in between
(±1, ±2) mean a subset agreed. A per-level breakdown renders
underneath — "PW ↑  VF ↑  CW ↑" for a fully-aligned-up day and whatever
combination of up, down, and em-dash glyphs fits the day otherwise.
Colors step through coral / amber / green at `|score| ≥ 2` so the site
paints a strong alignment without declaring it a signal; the framing is
informational. The IV Percentile stat was removed entirely (no
backward-compat shim), and the upstream `ivPercentile` /
`ivLookbackDays` fields on the `vrpMetric` derivation in `src/App.jsx`
were dropped with it because `LevelsPanel` was the only consumer. IV
Rank, VRP, and the two P/C ratio cells in the same row are unchanged.
The alignment score uses the client-side-corrected `volatility_flip` on
both days (the zero-crossing of the gamma profile) so the overnight
comparison isn't a mix of fresh profile today vs stale backend
gamma-max flip yesterday.

**Alpha (/alpha) and Beta (/beta) labs are now mobile-friendly at the
same breakpoints as the production dashboard.** The two lab shells
already inherited the viewport meta and some mobile scaling from the
original implementation, but the treatment stopped at the badge and
logo; the warning strip, the slot cards, the footer, and the placeholder
chrome all kept their desktop padding on phone widths. `src/styles/lab.css`
now adds a second pass at `@media (max-width: 768px)` that tightens
every lab-specific chrome element (warning padding, slot gap, card
padding scoped to `.lab-shell .card` so the main dashboard's cards are
untouched, placeholder font sizes, footer spacing) and a new
`@media (max-width: 480px)` block that scales one more step down for
phone-width viewports (badge height 2.8 → 2.4rem, meta 0.72 → 0.68rem,
footer letter-spacing eases for legibility at the smallest label size).
The structure of the layout is unchanged — nothing reflows, nothing
hides on mobile — so a component developed in a lab slot on desktop
renders in the same hierarchy on mobile. The two lab footers now
include a `v1.1.2` version token at the end of their existing text; the
alpha footer reads "AI Gamma LLC · α lab · software-stage sense ·
v1.1.2" and the beta footer reads "AI Gamma LLC · internal beta lab ·
not for public consumption · v1.1.2". The main dashboard at `/` does not
carry a visible version marker because the production surface has never
had a footer; readers who want to confirm the deployed version can read
it from `package.json` in the repo.

Verified clean: `npm run lint` returns 0 / 0, `npm run build` emits the
three entries with no vendor chunk regressions, `vite preview` serves
200 at `/`, `/alpha`, and `/beta`. The alpha slot content at
`alpha/slot.jsx` (the put-call parity box-spread model prompted by
sflush in the Discord chat) was deliberately not touched in this pass
— that component already imports `useIsMobile` and handles its own
responsive behavior internally, and it is also under a hands-off hold
until ~2026-04-23 because it is a visible example for a community
member.

## 2026-04-17 — Post-launch audit of Chrome extension + site

This is a findings-and-fixes log from a broad audit of the project after the
Chrome extension server side shipped (see commit `0e9ed6a`). The audit covered
the extension client (`aigamma-extension/`), the new Netlify Function
(`netlify/functions/snapshot.mjs`), the privacy page, the shared-module
extraction in `src/lib/dates.js`, the dashboard React tree, and the existing
ingest/data functions. Nothing visible on the dashboard changes behavior;
everything here is either a bug fix, a dead-code removal, a consolidation, or
a note worth tracking.

### Fixes shipped in this commit

**Extension client (`aigamma-extension/`)**

- `popup.js` — Expected Move was rendering with a misleading `+` sign prefix
  because it was passed through the `signed()` helper. Expected Move is a
  symmetric magnitude (always ≥ 0), not a directional signed value — rendering
  it as `+281.00` reads like a positive return rather than a bidirectional
  band. Added a new `magnitude()` formatter that prefixes with `±` instead,
  and pointed `expMove` at it. `distRiskOff` still uses `signed()` because the
  sign is meaningful there (positive = spot above Vol Flip, negative = spot
  below).
- `popup.js` — On fetch failure, only the status pill and the `asOf` row were
  being updated. Every other value row kept showing its initial "..." loading
  placeholder forever, which reads like "still loading" rather than "offline."
  The catch block now resets every value span to `-` so the OFFLINE state is
  unambiguous.
- `popup.js` — Dropped the unused `e` binding in the catch clause (ESLint
  `no-unused-vars`). Changed `catch (e)` to `catch`.
- `manifest.json` — Added `"homepage_url": "https://aigamma.com/"` so the
  Chrome Web Store listing has a canonical link back to the dashboard. No
  effect on runtime behavior.

**Dashboard (`src/`)**

- `hooks/useHistoricalData.js` — Removed two dead stub exports
  (`useHistoricalTermStructure` and `useHistoricalCloudBands`) that always
  returned `{ data: null, loading: false, error: null }` and had zero callers
  anywhere in the codebase. They were placeholders for features that never
  landed.
- `components/LevelsPanel.jsx` — Consolidated duplicate `isThirdFridayMonthly`
  definition. The helper was duplicated here and in `src/lib/dates.js` (the
  shared-module extraction from the previous commit). Removed the local copy
  and imported the shared one. Behavior is byte-identical — the two
  implementations agreed on every input — but having one source of truth
  means future edits to the SPX 3rd-Friday rule (e.g., a schedule change that
  shifts the AM-settled standard) only need a single edit.

**Netlify Functions**

- `ingest.mjs` / `ingest-background.mjs` — The hardcoded `US_MARKET_HOLIDAYS`
  sets expire at end of 2028. The comment above them said "Hardcoded through
  2028" but didn't flag what happens after. Extended the comment to call out
  the refresh deadline (before 2028-12-31) and describe the silent-failure
  mode on both sides: `ingest.mjs` would let the ingest fire on closed-market
  days (wasted Massive API calls, empty runs), and `ingest-background.mjs`'s
  `prevTradingDay` rollback would emit a closed-market day as the previous
  trading date.

### Observations left unchanged (context for future work)

These are things the audit found but chose not to touch, with reasons.

1. **`src/components/GammaThrottleScatter.jsx:416` — pre-existing lint
   violation.** The `react-hooks/set-state-in-effect` rule flags
   `setScatterError(null)` inside the Plotly render effect. It's a real
   pattern that React 19's strict mode discourages because it can cascade
   renders, but the fix requires either a `queueMicrotask` deferral, a ref-
   based error-state pattern, or restructuring the render to happen in an
   event handler. I didn't introduce the issue and a quick fix felt risky
   (the chart renders fine today), so I left it. It's the only lint error in
   the repo — worth fixing in a dedicated pass with visual verification that
   the chart still renders the same way on failure.

2. **Extension CSS palette differs from the site palette.** The site uses
   `#0d0f13` / `#141820` / `#4a9eff` / `#2ecc71`; the extension popup uses
   `#0b0f1a` / `#1f2937` / `#10b981` / `#ef4444` (closer to Tailwind slate +
   emerald). Not a bug — a stylistic divergence. The extension renders in a
   320px popup against Chrome's own chrome, where the cooler-slate palette
   looks a bit tighter than the site's palette would. CLAUDE.md says the two
   **dashboard surfaces** (aigamma.com + about.aigamma.com) should be
   consistent, which they are — the extension is a third surface with
   different presentation constraints. If you want to align, the fix is a
   two-line tweak in `aigamma-extension/popup.css` (swap the `--bg`, `--pos`,
   `--neg` values); I can do that on request.

3. **`netlify/functions/snapshot.mjs` 503 responses leak internal error
   messages.** On query failure, the body includes strings like
   `"computed_levels query failed: 500"` — i.e., internal table names. Not
   security-sensitive (no PII, no secrets), and the popup never renders the
   body (treats any non-200 as OFFLINE), so it's useful for debugging via
   curl. Acceptable tradeoff.

4. **`src/components/RangeBrush.jsx` doesn't explicitly call
   `releasePointerCapture`.** It calls `setPointerCapture` on pointerdown
   but relies on the browser's automatic release on pointerup at the
   captured target. That auto-release does fire correctly for all tested
   drag paths, so the code is not broken. Adding an explicit release would
   be slightly more defensive but is not a bug.

5. **`SUPBASE_SERVICE_KEY` typo in Netlify env (follow-up, not a code
   issue).** The service-role key is stored in Netlify production env as
   `SUPBASE_SERVICE_KEY` — missing the A in `SUPABASE`. This is almost
   certainly why the ingest pipeline's RLS-bypass INSERT for the gamma
   profile is being blocked, which is why the dashboard and now
   `snapshot.mjs` both recompute the Vol Flip client-side instead of
   reading `computed_levels.volatility_flip`. Renaming the env var to
   `SUPABASE_SERVICE_KEY` and redeploying the ingest function should
   restore persisted profile writes. This is ops work (Netlify dashboard),
   not a code change. The previous commit's rationale already documents
   this as a follow-up; it's repeated here for visibility.

### Verification

- `npm run build` passes (dist bundle size `265.76 kB` gzip `82.73 kB`,
  down from `265.88 kB` before the dead-hook removal and
  `isThirdFridayMonthly` consolidation — a ~0.12 kB ungzipped reduction).
- `npm run lint` shows **1 pre-existing error** (the
  `GammaThrottleScatter.jsx:416` case documented above), **0 warnings**.
  The popup.js lint error that was present before this audit is now cleared.
- Production endpoint `https://aigamma.com/api/snapshot.json` still returns
  200 with all three required headers (CORS, Cache-Control, Content-Type)
  and the full schema.
- Production privacy page `https://aigamma.com/extension-privacy` still
  returns 200 with content-length 6048 matching the published file.
