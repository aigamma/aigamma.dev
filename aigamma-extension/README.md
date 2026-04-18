# AI Gamma SPX Regime Status and Metrics Extension

Minimal Chrome extension that fetches derived SPX metrics from
https://aigamma.com/api/snapshot.json and displays them in a 320px popup.
A background service worker polls the same endpoint every 2 minutes
during US equity market hours and swaps the toolbar icon between
positive-, negative-, and neutral-gamma state glyphs so the dealer
regime is visible at a glance without opening the popup.
Manifest V3. Vanilla HTML, CSS, JavaScript. No bundler, no framework.

## Contents

    aigamma-extension/
      manifest.json
      background.js        service worker: polls snapshot, swaps icon
      popup.html
      popup.css
      popup.js
      icons/
        neutral/           AI GAMMA brand mark; used pre-market, off-hours, on load failure
          icon16.png
          icon32.png
          icon48.png
          icon128.png
        positive/          green plus; shown when gammaStatus == POSITIVE
          icon16.png
          icon32.png
        negative/          red minus; shown when gammaStatus == NEGATIVE
          icon16.png
          icon32.png

The manifest `action.default_icon` and `icons` entries both point at the
neutral set (all four sizes present) because that is what the Chrome Web
Store listing surfaces and what the toolbar shows before the first
successful fetch. The positive/negative sets only need 16 and 32 because
`background.js` exclusively passes those two sizes to
`chrome.action.setIcon`; Chrome upscales them for HiDPI toolbars, which
is fine for the flat plus/minus glyphs. Replace the placeholder icons
with the production mark before Chrome Web Store submission.

## Local testing

1. Open chrome://extensions
2. Toggle Developer mode on (top right).
3. Click Load unpacked and select the aigamma-extension folder.
4. Pin the extension from the toolbar puzzle icon.
5. Click the icon. Popup opens and fetches from aigamma.com/api/snapshot.json.

If the endpoint does not exist yet, the popup shows OFFLINE in red. That is
expected until the Netlify function is deployed.

## Server side

The extension fetches from `https://aigamma.com/api/snapshot.json`, a
Netlify Function that lives in this same repo at
`netlify/functions/snapshot.mjs` and is routed via `netlify.toml`
redirects. The function reads the same Supabase tables as the React
dashboard (`ingest_runs`, `snapshots`, `computed_levels`,
`expiration_metrics`, `daily_volatility_stats`) and recomputes the Vol
Flip zero crossing via the shared `src/lib/gammaProfile.js` helper so the
extension and the dashboard can never disagree on displayed levels. The
response contract is `schemaVersion: 1` and is pinned against `popup.js`.

Verify locally from the repo root:

    netlify dev
    curl -i http://localhost:8888/api/snapshot.json

The response should be `200 OK` with `Access-Control-Allow-Origin: *`,
`Cache-Control: public, max-age=30, s-maxage=30`, and a JSON body
matching the fields that `popup.js` reads (`spot`, `putWall`, `volFlip`,
`callWall`, `distanceFromRiskOff`, `atmIv`, `vrp`, `ivRank`,
`pcRatioVolume`, `gammaStatus`, `asOf`). Deploy on push to `main` as
usual.

## Publishing to the Chrome Web Store

1. Pay the one-time $5 developer registration fee at
   https://chrome.google.com/webstore/devconsole
2. Produce at least one screenshot (1280x800 or 640x400) of the popup.
3. Host a privacy policy page at a stable URL, for example
   https://aigamma.com/extension-privacy . See PRIVACY.md for a draft.
4. Zip the CONTENTS of aigamma-extension\ (not the folder itself).
   On Windows PowerShell, from inside the folder:
     Compress-Archive -Path * -DestinationPath ..\aigamma-extension.zip
5. Click New Item in the developer console, upload the zip.
6. Fill the listing. Category: Productivity.
7. Submit. Review is typically 1 to 3 business days for low-permission MV3
   extensions. The manifest declares only `"alarms"` (used by the
   background service worker to poll the snapshot endpoint every 2
   minutes during market hours and swap the toolbar icon between the
   neutral / positive / negative glyphs); no `host_permissions`, no
   content scripts, no storage, no tabs. Reviewers can verify in-code
   that no user data is read or transmitted.

## Updating later

Bump the version field in manifest.json (semver), rezip, upload as a new
version in the developer console. The endpoint contract (schemaVersion = 1)
should stay stable so old extension versions in the wild keep working.
