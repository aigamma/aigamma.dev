# Changelog

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
