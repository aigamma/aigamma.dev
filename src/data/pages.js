// src/data/pages.js
//
// Canonical page registry for aigamma.com. Single source of truth for every
// page's build entry, navigation placement, and chat surface configuration.
// Consumers (vite.config.js, src/components/Menu.jsx, src/components/
// MobileNav.jsx, src/components/TopNav.jsx, scripts/rag/ingest.mjs) derive
// their own representations from this registry rather than maintaining
// parallel literals.
//
// When adding/removing/renaming a page, edit this file plus the per-file
// surfaces enumerated in the ## Source-of-Truth Map section of CLAUDE.md
// (the page code itself, the chat.mjs SYSTEM_PROMPTS map for new chat-
// enabled pages, the per-page prompt module, src/data/site-index.txt, and
// any sibling-page prose references in other prompts). Run scripts/check-
// page-consistency.mjs to verify nothing drifted.
//
// PAGES is the canonical map keyed by URL path. Insertion order matters:
// the helpers below preserve it so the on-page menu order matches what
// the registry declares. Order is:
//   1. Homepage (/)
//   2. TopNav five in their left-to-right order (curated by importance)
//   3. Menu Tools in curated order (importance, not alphabetical)
//   4. Menu Research in alphabetical order (so URL discovery is linear)
//   5. /disclaimer/ entry (page exists but is not exposed in any
//      Menu / TOOLS / RESEARCH dropdown — the disclaimer is reachable
//      from the right-corner chat-header chip and from every page's
//      footer, both of which already make it unmistakable, so a
//      duplicate dropdown link added redundancy with no discovery
//      benefit and was removed on 2026-05-08)
//   6. Sandboxes (/alpha/, /beta/, /dev/) — vite-only, no nav, no chat
//
// Field reference:
//   vite          — vite_entry name (matches rollupOptions.input key)
//   html          — relative path to the entry HTML
//   title         — short title (used in page-badge / browser tab when relevant)
//   chat          — { surface, prompt } if the page mounts a Chat component
//                   (homepage + 11 pages); absent on pages that don't
//   topnav        — { key, label } if the page is in the promoted top nav
//                   (only six pages). label is the desktop button text;
//                   key is the matcher for the TopNav `current` prop
//   menu          — { section, desc } if the page is in the desktop Menu
//                   dropdown. section is 'tools' | 'research' | 'about'.
//                   desc is the one-line description shown next to the URL
//   mobile_desc   — overrides menu.desc / topnav-derived desc in the mobile
//                   dropdown if present; otherwise falls through. Useful
//                   when the desktop desc is too verbose for narrow phone
//                   widths (the canonical example is /local/, where the
//                   Menu carries the full surface enumeration but the
//                   mobile dropdown shortens it)

export const PAGES = {
  // ---- Homepage ---------------------------------------------------------
  '/': {
    vite: 'main',
    html: 'index.html',
    title: 'AI Gamma',
    chat: { surface: 'main', prompt: 'netlify/functions/prompts/main.mjs' },
  },

  // ---- TopNav five (left-to-right by importance) -----------------------
  '/tactical/': {
    vite: 'tactical',
    html: 'tactical/index.html',
    title: 'Tactical Vol',
    chat: { surface: 'tactical', prompt: 'netlify/functions/prompts/tactical.mjs' },
    topnav: { key: 'tactical', label: 'Vol' },
    mobile_desc: 'VRP, term structure, RND, fixed-strike IV',
  },
  '/earnings/': {
    vite: 'earnings',
    html: 'earnings/index.html',
    title: 'Earnings',
    topnav: { key: 'earnings', label: 'Earnings' },
    mobile_desc: 'Earnings calendar by implied move and date',
  },
  '/scan/': {
    vite: 'scan',
    html: 'scan/index.html',
    title: 'Scan',
    topnav: { key: 'scan', label: 'Scan' },
    mobile_desc: '25Δ skew vs ATM IV scanner across single names',
  },
  '/rotations/': {
    vite: 'rotations',
    html: 'rotations/index.html',
    title: 'Rotations',
    topnav: { key: 'rotations', label: 'Rotations' },
    mobile_desc: 'Sector rotation chart and 1D/1W/1M bar trio',
  },
  '/seasonality/': {
    vite: 'seasonality',
    html: 'seasonality/index.html',
    title: 'Seasonality',
    topnav: { key: 'seasonality', label: 'Season' },
    mobile_desc: 'SPX intraday and daily seasonality grids',
  },

  // ---- Menu Tools (curated order, importance not alphabetical) ---------
  '/stocks/': {
    vite: 'stocks',
    html: 'stocks/index.html',
    title: 'Stocks',
    menu: { section: 'tools', desc: 'Top option-liquid names, performance + rotation' },
  },
  '/heatmap/': {
    vite: 'heatmap',
    html: 'heatmap/index.html',
    title: 'Heatmap',
    menu: { section: 'tools', desc: 'Equal-size top-250-by-options-volume heatmap' },
  },
  '/events/': {
    vite: 'events',
    html: 'events/index.html',
    title: 'Events',
    menu: { section: 'tools', desc: 'US economic event calendar' },
  },
  '/expiring-gamma/': {
    vite: 'expiring-gamma',
    html: 'expiring-gamma/index.html',
    title: 'Expiring Gamma',
    menu: { section: 'tools', desc: 'Gamma scheduled to expire per date' },
  },

  // ---- Menu Research (alphabetical) ------------------------------------
  '/discrete/': {
    vite: 'discrete',
    html: 'discrete/index.html',
    title: 'Discrete',
    chat: { surface: 'discrete', prompt: 'netlify/functions/prompts/discrete.mjs' },
    menu: { section: 'research', desc: 'Binomial and trinomial trees, three SVI parameterizations (raw, natural, JW), SSVI joint surface' },
  },
  '/garch/': {
    vite: 'garch',
    html: 'garch/index.html',
    title: 'GARCH',
    chat: { surface: 'garch', prompt: 'netlify/functions/prompts/garch.mjs' },
    menu: { section: 'research', desc: 'GARCH ensemble of RV forecasts' },
  },
  '/jump/': {
    vite: 'jump',
    html: 'jump/index.html',
    title: 'Jump',
    chat: { surface: 'jump', prompt: 'netlify/functions/prompts/jump.mjs' },
    menu: { section: 'research', desc: 'Variance gamma, Heston, Bates SVJ, Kou, Merton' },
  },
  '/local/': {
    vite: 'local',
    html: 'local/index.html',
    title: 'Local',
    chat: { surface: 'local', prompt: 'netlify/functions/prompts/local.mjs' },
    menu: { section: 'research', desc: 'Dupire extraction, MC pricing self-check, slice viewer, forward-smile pathology, whole-surface heatmap' },
    mobile_desc: 'Dupire extraction, pricing, slices, forward-smile pathology, surface heatmap',
  },
  '/regime/': {
    vite: 'regime',
    html: 'regime/index.html',
    title: 'Regime',
    chat: { surface: 'regime', prompt: 'netlify/functions/prompts/regime.mjs' },
    menu: { section: 'research', desc: 'Mixture, Markov, Wasserstein' },
  },
  '/risk/': {
    vite: 'risk',
    html: 'risk/index.html',
    title: 'Risk',
    chat: { surface: 'risk', prompt: 'netlify/functions/prompts/risk.mjs' },
    menu: { section: 'research', desc: 'Cross-model Greeks, four-delta comparison, Vanna-Volga, second-order Greeks' },
  },
  '/rough/': {
    vite: 'rough',
    html: 'rough/index.html',
    title: 'Rough',
    chat: { surface: 'rough', prompt: 'netlify/functions/prompts/rough.mjs' },
    menu: { section: 'research', desc: 'Rough Bergomi simulator + skew scaling-law fit, RFSV diagnostic, three-estimator Hurst triangulation' },
    mobile_desc: 'rBergomi simulator, skew scaling-law fit, RFSV, three-estimator Hurst triangulation',
  },
  '/vix/': {
    vite: 'vix',
    html: 'vix/index.html',
    title: 'VIX',
    menu: { section: 'research', desc: 'VIX family term structure, OU mean reversion, VVIX/VIX complacency, SDEX/TDEX, regime classifier, Cboe strategy benchmarks' },
    mobile_desc: 'VIX term structure, contango, Ornstein-Uhlenbeck, VVIX, SDEX/TDEX, regimes, Cboe strategies',
  },
  // ---- Disclaimer page (intentionally not exposed in any nav dropdown;
  //      the right-corner chat-header chip and the page-footer link both
  //      already surface it on every page) -----------------------------
  '/disclaimer/': {
    vite: 'disclaimer',
    html: 'disclaimer/index.html',
    title: 'Disclaimer',
  },

  // ---- Public analytics surface (not in any nav dropdown either;
  //      reachable from the page-footer link added alongside the
  //      disclaimer entry). Renders the rolled-up payload from
  //      /api/stats. Same data, same view, for every visitor.
  //      No auth, no privileged dashboard, no cookies. --------------------
  '/stats/': {
    vite: 'stats',
    html: 'stats/index.html',
    title: 'Stats',
  },

  // ---- Dev sandboxes (vite-only, no nav, no chat) ----------------------
  // These are active development environments, not retired pages. They
  // intentionally do not mount the Chat component because the experimental
  // models on them are not stable enough to defend in dialogue. See the
  // dev-sandboxes-no-chat memory for context.
  '/alpha/': {
    vite: 'alpha',
    html: 'alpha/index.html',
    title: 'Alpha (sandbox)',
  },
  '/beta/': {
    vite: 'beta',
    html: 'beta/index.html',
    title: 'Beta (sandbox)',
  },
  '/dev/': {
    vite: 'dev',
    html: 'dev/index.html',
    title: 'Dev (sandbox)',
  },
};

// ---------------------------------------------------------------------------
// Derived helpers. Consumers import these rather than re-deriving the same
// transformations. Insertion order from PAGES is preserved.

// Vite multi-page entries: { entry_name: html_path }
export const VITE_ENTRIES = Object.fromEntries(
  Object.values(PAGES).map((p) => [p.vite, p.html])
);

// Top nav buttons (the five promoted pages)
export const TOPNAV_ITEMS = Object.entries(PAGES)
  .filter(([_, p]) => p.topnav)
  .map(([href, p]) => ({ key: p.topnav.key, href, label: p.topnav.label }));

// Desktop Menu items, split by section. There is no longer an `about`
// section: /disclaimer/ used to live there but was removed from the
// dropdown on 2026-05-08 (already surfaced via the right-corner chat-
// header chip and the page-footer link on every page), and the off-site
// "About This Page" exit link is hardcoded directly in Menu.jsx because
// it points off-domain to about.aigamma.com and never had a registry
// entry.
export const MENU_TOOLS = Object.entries(PAGES)
  .filter(([_, p]) => p.menu?.section === 'tools')
  .map(([href, p]) => ({ href, label: href, desc: p.menu.desc }));

export const MENU_RESEARCH = Object.entries(PAGES)
  .filter(([_, p]) => p.menu?.section === 'research')
  .map(([href, p]) => ({ href, label: href, desc: p.menu.desc }));

// Mobile dropdown items. TOOLS dropdown holds (a) all top-nav promoted
// pages and (b) all desktop-Menu Tools pages, in that order. RESEARCH
// dropdown mirrors the desktop Menu Research section. mobile_desc takes
// precedence over the desktop desc where it's set on a page (lets the
// mobile copy be tighter on narrow phone widths).
export const MOBILE_TOOLS = [
  ...Object.entries(PAGES)
    .filter(([_, p]) => p.topnav)
    .map(([href, p]) => ({ href, label: href, desc: p.mobile_desc || '' })),
  ...Object.entries(PAGES)
    .filter(([_, p]) => p.menu?.section === 'tools')
    .map(([href, p]) => ({ href, label: href, desc: p.mobile_desc || p.menu.desc })),
];

export const MOBILE_RESEARCH = Object.entries(PAGES)
  .filter(([_, p]) => p.menu?.section === 'research')
  .map(([href, p]) => ({ href, label: href, desc: p.mobile_desc || p.menu.desc }));

// Chat-enabled pages (used by chat.mjs to verify the SYSTEM_PROMPTS map and
// by ingest.mjs to derive its SOURCES list).
export const CHAT_PAGES = Object.entries(PAGES)
  .filter(([_, p]) => p.chat)
  .map(([path, p]) => ({
    path,
    surface: p.chat.surface,
    prompt: p.chat.prompt,
  }));
