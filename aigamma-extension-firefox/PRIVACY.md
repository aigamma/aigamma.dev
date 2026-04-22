# AI Gamma SPX Regime Status and Metrics — Privacy Policy

Last updated: 2026-04-18
Canonical URL: https://aigamma.com/extension-privacy

The AI Gamma SPX Regime Status and Metrics browser extension ("the extension")
is published by Eric Allione (AI Gamma, Prescott, AZ) and operates as
described below.

## What the extension does

When the user clicks the extension icon, the popup issues a single HTTPS
request to https://aigamma.com/api/snapshot.json and renders the returned
derived SPX market statistics. In the background, a service worker issues
the same request on a schedule during US equity market hours and updates the
toolbar icon to reflect the current gamma regime. No other network activity
occurs.

## What the extension collects

The extension does not collect, store, or transmit any personal information,
browsing history, cookies, form data, keystrokes, clipboard contents, account
credentials, or information about any tab, site, or account other than its
own popup surface.

The extension has no content scripts and cannot read data from any web page
the user visits. The extension declares no host_permissions and has no
ability to observe or modify traffic on any site other than its own single
fetch to aigamma.com.

The extension uses no local storage, no sync storage, no usage analytics
or telemetry, no advertising identifiers, and no third-party SDKs.

## What aigamma.com receives

The snapshot endpoint at aigamma.com/api/snapshot.json is a public,
unauthenticated resource. Requests made by the extension are standard HTTPS
requests. The receiving server records only standard HTTP request metadata
(IP address, user agent, timestamp) as part of normal operational logging.
This metadata is not linked to any user identity, is not retained beyond
operational need, and is not shared with third parties.

## Permissions justification

The extension declares only one permission: `alarms`, used by the background
service worker to schedule periodic fetches of the snapshot endpoint during
market hours. The extension does not declare `host_permissions`, `tabs`,
`activeTab`, `storage`, `cookies`, `scripting`, `webRequest`, or any other
permission. The cross-origin fetch to aigamma.com is permitted because the
endpoint returns CORS headers allowing any origin.

## Data sharing

No data is shared with third parties because no user data is collected.

## Contact

support@aigamma.com
