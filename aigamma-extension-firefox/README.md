# AI Gamma SPX Regime Status and Metrics — Firefox Variant

Firefox WebExtensions (MV3) port of the Chrome extension in
`../aigamma-extension/`. Same `popup.html`, `popup.css`, `popup.js`,
`background.js`, `PRIVACY.md`, and `icons/` — only the manifest differs.

## Why a separate directory

Firefox does not support `background.service_worker` yet (Firefox
bug 1573659 is still open as of early 2026); Firefox MV3 backgrounds use
the non-persistent event-page pattern with `background.scripts` instead.
A single shared manifest would fail to load cleanly in both runtimes.
AMO also requires `browser_specific_settings.gecko.id` and, as of
2025-11-03, a `data_collection_permissions` declaration (introduced in
the gecko runtime in Firefox 140 desktop / 142 Android), neither of
which Chrome honors. Two directories, one manifest diff — minimal
maintenance, maximum clarity.

`strict_min_version: "142.0"` is set to the oldest Firefox release that
recognizes `data_collection_permissions` on both desktop and Android, so
`web-ext lint --self-hosted` passes with zero warnings. An older
`strict_min_version` is also valid (the `data_collection_permissions`
key is simply ignored on older gecko runtimes, and the declared value
`"none"` is indistinguishable from the default behavior) but the
`web-ext` linter flags the inconsistency, so we pin to 142.0 to ship
clean.

The shared `background.js` works in both browsers because every API it
touches (`chrome.runtime.onInstalled`, `chrome.runtime.onStartup`,
`chrome.alarms`, `chrome.action.setIcon`, `fetch`, `AbortController`,
`Intl.DateTimeFormat`) has identical semantics in Chrome MV3 service
workers and Firefox MV3 event pages. `chrome.*` is an alias for
`browser.*` in Firefox; calls return promises in both runtimes.

## Contents

    aigamma-extension-firefox/
      manifest.json        Firefox-specific: background.scripts + gecko settings
      background.js        shared with Chrome variant
      popup.html           shared
      popup.css            shared
      popup.js             shared
      icons/               shared (neutral / positive / negative subfolders)

## Local testing

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select this folder's `manifest.json`
4. The extension loads until Firefox is restarted (temporary installs
   are scrubbed on browser close — for persistent local testing, use a
   Developer Edition / Nightly / ESR build and install a signed XPI)
5. Pin the extension from the toolbar overflow menu
6. Click the icon. Popup fetches from
   `https://aigamma.com/api/snapshot.json` and renders the regime card.

The toolbar icon swaps between the neutral AI GAMMA mark, the green
plus, and the red minus the same way it does in Chrome, driven by the
2-minute `chrome.alarms` poll and the `gammaStatus` field of the
snapshot response.

## Publishing to AMO (addons.mozilla.org)

1. Create a Mozilla account at https://addons.mozilla.org/ if you do
   not have one. There is no developer registration fee.
2. Zip the CONTENTS of this folder (not the folder itself). On Windows
   PowerShell, from inside this folder:
       Compress-Archive -Path * -DestinationPath ..\aigamma-extension-firefox.zip
3. Go to https://addons.mozilla.org/developers/addon/submit/ and choose
   **On this site** (listed distribution).
4. Upload the zip. The automated validator runs immediately; for a
   low-permission MV3 extension (only `alarms`, no `host_permissions`,
   no content scripts, no remote code) it typically signs and publishes
   within minutes without manual review.
5. Fill the listing metadata: name, summary, category (Productivity),
   support email (ericallione@gmail.com), support URL (aigamma.com),
   license, and privacy policy URL
   (https://aigamma.com/extension-privacy). Source code submission is
   only required if the bundle contains minified or obfuscated code —
   this extension ships unminified vanilla JS, so the uploaded zip is
   itself reviewable source.
6. Submit. The extension appears on AMO and signed XPIs become
   installable from the listing.

## Updating later

Bump the `version` field in `manifest.json` (semver, must be higher
than the currently-published AMO version), rezip, and upload as a new
version via the same developer dashboard. The endpoint contract
(`schemaVersion: 1` from `https://aigamma.com/api/snapshot.json`)
should stay stable so older extension versions in the wild keep
working.
