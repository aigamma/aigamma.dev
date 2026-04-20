# AI Gamma SPX Regime Status and Metrics

A Chrome and Firefox browser extension that surfaces derived SPX derivative
metrics from https://aigamma.com/api/snapshot.json in a 320px popup and
reflects the current dealer gamma regime on the toolbar icon at a glance.

Manifest V3. Vanilla HTML, CSS, and JavaScript. No bundler, no framework,
no third-party runtime dependencies.

## Layout

    aigamma-extension/
      manifest.json
      background.js        service worker: polls snapshot, swaps icon
      popup.html
      popup.css
      popup.js
      PRIVACY.md
      README.md
      icons/
        neutral/           AI GAMMA brand mark; used pre-market, off-hours,
                           on fetch failure, and on the Chrome Web Store listing
          icon16.png
          icon32.png
          icon48.png
          icon128.png
        positive/          green plus; shown when gammaStatus === "POSITIVE"
          icon16.png
          icon32.png
        negative/          red minus; shown when gammaStatus === "NEGATIVE"
          icon16.png
          icon32.png

The manifest's `action.default_icon` and top-level `icons` entries both point
at the neutral set (all four sizes present) because that is what the Chrome
Web Store listing surfaces and what the toolbar displays before the first
successful fetch. The positive and negative sets only need 16 and 32 because
`background.js` exclusively passes those two sizes to
`chrome.action.setIcon`. Chrome upscales them for HiDPI toolbars, which
renders cleanly for the flat plus and minus glyphs.

## Behavior

The popup fetches on open and renders the latest snapshot. The background
service worker schedules a `chrome.alarms` tick every two minutes, gated to
US equity market hours (Monday through Friday, 9:30 AM to 4:00 PM Eastern,
DST-aware via `Intl.DateTimeFormat` with `timeZone: "America/New_York"`).
Outside market hours the service worker no-ops because the regime cannot
change. On fetch failure, the icon reverts to neutral.

## Local testing

1. Open `chrome://extensions`.
2. Toggle Developer mode on (top right).
3. Click Load unpacked and select the `aigamma-extension` folder.
4. Pin the extension from the toolbar puzzle icon.
5. Click the icon. The popup opens and fetches from
   `aigamma.com/api/snapshot.json`.

If the endpoint is unreachable, the popup displays OFFLINE in red and the
toolbar icon falls back to neutral.

## Server side

The extension fetches from `https://aigamma.com/api/snapshot.json`, a
Netlify Function that lives in the same repository at
`netlify/functions/snapshot.mjs` and is routed via `netlify.toml` redirects.
The function reads the same Supabase tables as the aigamma.com React
dashboard (`ingest_runs`, `snapshots`, `computed_levels`,
`expiration_metrics`, `daily_volatility_stats`) and recomputes the Vol Flip
zero crossing via the shared `src/lib/gammaProfile.js` helper so the
extension and the dashboard can never disagree on displayed levels. The
response contract is `schemaVersion: 1` and is pinned against `popup.js`.

Verify locally from the repo root:

    netlify dev
    curl -i http://localhost:8888/api/snapshot.json

The response should be `200 OK` with `Access-Control-Allow-Origin: *`,
`Cache-Control: public, max-age=30, s-maxage=30`, and a JSON body matching
the fields that `popup.js` reads: `spot`, `putWall`, `volFlip`, `callWall`,
`distanceFromRiskOff`, `atmIv`, `vrp`, `ivRank`, `pcRatioVolume`,
`gammaStatus`, `asOf`, and `overnightAlignment` (optional; the third row in
the popup — net +1/0/-1 score and per-level arrows comparing today's Put
Wall, Vol Flip, and Call Wall against the most recent prior trading day's
run).

## Publishing

### Chrome Web Store

1. Pay the one-time $5 developer registration fee at
   https://chrome.google.com/webstore/devconsole.
2. Produce at least one screenshot (1280x800 or 640x400) of the popup.
3. Host the privacy policy at https://aigamma.com/extension-privacy.
   Source content lives in `PRIVACY.md`.
4. Zip the *contents* of this folder (not the folder itself). On Windows
   PowerShell, from inside `aigamma-extension/`:

        Compress-Archive -Path * -DestinationPath ..\aigamma-extension.zip

5. In the developer console, click New Item, upload the zip.
6. Fill the listing. Category: Productivity.
7. Submit. Review is typically one to three business days for low-permission
   MV3 extensions. The manifest declares only `alarms`; no host_permissions,
   no content scripts, no storage, no tabs. Reviewers can verify in-code that
   no user data is read or transmitted.

### Firefox (addons.mozilla.org)

The same codebase is Firefox-compatible with one manifest addition:

    "browser_specific_settings": {
      "gecko": {
        "id": "aigamma@aigamma.com",
        "strict_min_version": "115.0"
      }
    }

Firefox recognizes `background.scripts` rather than `background.service_worker`,
so the background field can declare both for cross-browser support. Submit the
same zip (with the gecko settings added) to addons.mozilla.org. AMO review
typically takes three to ten business days.

## Updating

Bump the `version` field in `manifest.json` using semver, rezip, and upload
as a new version in each store's developer console. The endpoint contract
(`schemaVersion: 1`) stays stable so that older extension versions in the
wild continue to work.
