# AI Gamma SPX Regime Status and Metrics - Privacy Policy

Last updated: 2026-04-17

The AI Gamma SPX Regime Status and Metrics browser extension ("the extension") is published
by AI Gamma LLC and operates as follows.

## What the extension does

When the user clicks the extension icon, the popup issues a single HTTPS
request to https://aigamma.com/api/snapshot.json and renders the returned
derived SPX market statistics.

## What the extension collects

The extension does not collect, store, or transmit any personal information,
browsing history, cookies, form data, keystrokes, clipboard contents, or
information about other tabs, sites, or accounts.

The extension uses no local storage, no sync storage, no analytics, no
advertising identifiers, and no third-party SDKs.

## What aigamma.com receives

The snapshot endpoint at aigamma.com/api/snapshot.json is a public,
unauthenticated resource. Requests made by the extension are standard HTTPS
requests. The receiving server receives only standard HTTP request metadata
(IP address, user agent, timestamp) for the purposes of rate limiting and
operational logging. No user-identifying data is associated with these
requests.

## Permissions justification

The extension declares no permissions. It does not use host_permissions,
content scripts, or any permission APIs. The popup makes a single
cross-origin fetch to https://aigamma.com/api/snapshot.json, which is
permitted because the endpoint returns CORS headers allowing any origin.

## Data sharing

No data is shared with third parties because no user data is collected.

## Contact

ericallione@gmail.com
