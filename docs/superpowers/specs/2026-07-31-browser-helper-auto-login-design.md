# Browser Helper and Automatic Gemini Session Renewal Design

Date: 2026-07-31
Status: approved in conversation; awaiting written-spec review

## 1. Goal

Extend the Docker-only, SQLite-backed web2gem deployment with a separate
browser-helper container that maintains Gemini account sessions.

The helper must:

- keep one persistent Chromium profile per Gemini account;
- periodically check enabled accounts and refresh their stored cookies;
- attempt Google login with an encrypted email, password, and TOTP secret only
  after the persistent profile has lost its session;
- stop and request manual intervention for CAPTCHA, passkey, phone approval,
  account recovery, or any unknown challenge;
- expose a noVNC browser that the administrator can open from the account row;
- support noVNC clipboard copy and paste;
- send signed Feishu webhook notifications without leaking secrets;
- continue to use local SQLite and require no Cloudflare service.

Automatic login is best effort. It must not attempt to bypass Google security
challenges or repeatedly retry a rejected login.

## 2. Deployment Architecture

One Compose project runs two containers:

1. `web2gem`
   - serves the API and administration UI;
   - owns all SQLite reads and writes;
   - validates replacement cookies before committing them;
   - encrypts login credentials before storage;
   - exposes the existing application port, currently `18080` in the target
     deployment.
2. `browser-helper`
   - runs Chromium, Xvfb, a VNC server, noVNC, and a small Node.js controller;
   - owns the persistent browser profiles;
   - schedules checks and serializes browser work;
   - decrypts credentials only for an active automatic-login attempt;
   - exposes noVNC only on host loopback, default
     `127.0.0.1:6080:6080`.

The containers communicate over a private Compose network. The helper never
writes SQLite directly. It uses narrowly scoped internal web2gem endpoints
authenticated with a random internal token.

Persistent storage is split into two named volumes:

- `web2gem-data`: `/data/web2gem.sqlite` and its SQLite WAL files;
- `browser-profiles`: `/profiles/<account-id>` Chromium profiles.

Only `web2gem` mounts `web2gem-data`. Only `browser-helper` mounts
`browser-profiles`.

## 3. Account and Browser State

SQLite gains browser-maintenance metadata associated one-to-one with each
Gemini account. It records:

- whether automatic login credentials are configured;
- encrypted credential ciphertext, nonce, authentication tag, and format
  version;
- browser state: `idle`, `checking`, `ready`, `login_required`,
  `manual_action_required`, or `error`;
- last check, last successful cookie update, and last automatic login times;
- consecutive authentication failures;
- daily automatic-login attempt count and its date bucket;
- notification state used to deduplicate Feishu alerts;
- a bounded, non-sensitive failure code.

The API and UI must never return ciphertext, password, TOTP secret, cookie
values, internal tokens, or webhook secrets. They return only booleans,
timestamps, state, and safe failure codes.

The initial migration is additive and idempotent. Existing Gemini accounts,
cookies, models, and routing priorities remain unchanged. Accounts begin with
no automatic-login credentials and no browser profile until first use.

## 4. Credential Protection

The administration UI accepts:

- Google account email;
- Google account password;
- base32 TOTP seed.

Before accepting the input, web2gem validates field size and validates that the
TOTP seed is syntactically valid without logging it. The three values are
serialized as one versioned payload and encrypted with AES-256-GCM.

The encryption key is a 32-byte random master key supplied as a Docker Secret
at `/run/secrets/web2gem_master_key`. It is never stored in `.env`, an image,
SQLite, logs, API responses, or Git. Both containers receive the same read-only
secret. The account ID and credential format version are AES-GCM additional
authenticated data, preventing ciphertext from being moved between accounts.

When browser-helper needs credentials, web2gem returns the encrypted payload
over the private network after internal-token authentication. The helper
decrypts it only in memory for the active login attempt and drops references
after use. It never writes plaintext credentials to the profile, disk, logs,
screenshots, notifications, or browser state responses.

Credential updates follow these rules:

- blank fields preserve the existing encrypted credentials;
- replacing credentials requires all three fields;
- clearing credentials is a separate confirmed action;
- deleting an account deletes its encrypted credentials and browser metadata;
- profile deletion is a separate explicit action and is not part of account
  deletion in the first version, preventing accidental loss during recovery.

## 5. Scheduled Session Maintenance

Only enabled accounts are scheduled. The default interval is six hours and is
configurable. Account checks are jittered so they do not start together.

The helper uses a single global browser-work queue. Only one Chromium process
may use an account profile at a time, and only one visible noVNC account may be
active. This deliberately favors safety and low resource use over throughput.

For each scheduled check:

1. Acquire the account job lock from web2gem.
2. Start Chromium headlessly with `/profiles/<account-id>`.
3. Navigate to the configured Gemini origin through the container's configured
   proxy settings.
4. Determine whether the profile is authenticated.
5. If authenticated, extract only `__Secure-1PSID` and
   `__Secure-1PSIDTS`.
6. Submit those values to the internal cookie-replacement endpoint.
7. Let web2gem normalize them, build a candidate session, probe Gemini, and
   atomically update SQLite only after verification succeeds.
8. Refresh account capabilities and model routing after a successful update.
9. Close Chromium and release the job lock.

An unchanged cookie is a successful check but does not rewrite the secret
columns. It updates only the last-check state.

The profile-to-account association is authoritative, but automatic replacement
also checks the observed signed-in email against the configured email when the
page exposes a reliable value. If the email is different, or identity cannot be
verified after a login flow, the helper does not replace the cookie and requests
manual action.

The old cookie is retained for every failed or inconclusive check.

## 6. Automatic Login

Automatic login is attempted only when all of these are true:

- the profile is no longer authenticated;
- encrypted credentials are configured;
- the account is enabled;
- no manual browser session is active;
- the account has made fewer than two automatic-login attempts in the current
  local calendar day;
- it is not already in a manual-action state.

The helper handles only the expected email, password, and authenticator-TOTP
steps. TOTP uses the standard time-based algorithm locally with a small clock
window. System time must be synchronized; a clock-skew error is reported rather
than causing repeated submissions.

The helper immediately stops automatic interaction when it sees CAPTCHA,
passkey, phone approval, account recovery, device confirmation, suspicious
login review, or an unknown page. It does not bypass, solve, or repeatedly
submit these challenges.

After an apparent login, it verifies Gemini access and the account identity,
then follows the normal validated cookie-replacement path. A successful manual
or automatic recovery clears the authentication alert and sends one recovery
notification.

## 7. Manual Browser and Clipboard

Each account row gains these controls and indicators:

- automatic login: configured or not configured;
- browser state;
- last check time;
- configure login credentials;
- clear credentials;
- check now;
- open browser.

Clicking `Open browser` is a user gesture. The UI immediately opens a waiting
tab, asks browser-helper to start the selected profile in visible mode, and
navigates the tab to noVNC when ready. This avoids popup blocking after an
asynchronous startup.

noVNC is password protected and bound to `127.0.0.1` by default. Its clipboard
panel is enabled for explicit text copy and paste between the Windows client
and the container browser. The helper does not read Windows clipboard history.

Only one visible account is active at once. Opening another account asks for
confirmation, closes the current Chromium process cleanly, and starts the new
profile. A visible session has an idle timeout but is never killed while an
active login form is being submitted. Closing a manual session triggers one
final cookie verification.

## 8. Internal APIs and Trust Boundaries

The private helper API is not exposed through the host port. It provides the
minimum operations needed to:

- list enabled account IDs and safe scheduling state;
- acquire and release account browser-job locks;
- retrieve one encrypted credential blob;
- submit candidate cookie values for validation and atomic replacement;
- update safe browser state and timestamps;
- request an account capability refresh.

The administration API provides authenticated operations to configure or clear
credentials, request an immediate check, start a visible session, stop a
visible session, and read safe status.

The internal token and `ADMIN_KEY` are different values. Requests are bounded,
validated, rate limited, and compared using timing-safe equality. Cookie and
credential payloads are redacted from request logs and error details.

The noVNC port must remain loopback-only unless the operator adds a separate
authenticated TLS reverse proxy. Remote exposure is outside this version's
scope.

## 9. Feishu Notifications

The helper sends signed Feishu bot webhook messages for state transitions, not
for every failed check. The webhook URL and signing secret are runtime
environment variables and are never committed or returned by an API.

Messages contain only:

- account label and non-secret account ID suffix;
- safe state and failure category;
- event time;
- local noVNC address;
- suggested manual action.

The following transitions notify once:

- session becomes `login_required`;
- automatic login reaches `manual_action_required`;
- browser maintenance enters a persistent `error` state;
- the account returns to `ready` after an authentication alert.

Notification delivery failure is logged safely and retried with bounded
backoff. It never blocks cookie validation or account recovery.

The webhook and signing secret disclosed during design must be rotated before
deployment. The disclosed values are intentionally absent from this document.

## 10. Failure Handling

Two consecutive authentication failures are required before declaring the
profile logged out, unless Google presents an explicit login or challenge page.
Transient proxy, DNS, timeout, or upstream errors remain retriable maintenance
errors and do not trigger credential submission.

Browser crashes affect only browser-helper. The web2gem API continues serving
with the last validated cookie. Compose restarts browser-helper automatically.

The queue and job lease recover after helper restart. Stale locks expire.
Chromium is always terminated before another process opens the same profile.

If the master key is missing or invalid, web2gem starts without automatic-login
credential operations, preserves encrypted data, and reports a clear safe
configuration error. It must never silently create a replacement key, because
that would make existing ciphertext unrecoverable.

## 11. Configuration

New configuration names, with secret values omitted, are:

- `BROWSER_HELPER_INTERNAL_URL`
- `BROWSER_HELPER_INTERNAL_TOKEN`
- `BROWSER_CHECK_INTERVAL_SEC` (default `21600`)
- `BROWSER_CHECK_JITTER_SEC`
- `BROWSER_VISIBLE_IDLE_TIMEOUT_SEC`
- `BROWSER_AUTLOGIN_MAX_ATTEMPTS_PER_DAY` (default `2`)
- `NOVNC_PORT` (default `6080`)
- `NOVNC_PASSWORD`
- `FEISHU_WEBHOOK_URL`
- `FEISHU_SIGNING_SECRET`
- `/run/secrets/web2gem_master_key`

Proxy variables already used by web2gem are also passed to browser-helper so
Chromium and Node.js use the same intended network route.

## 12. Testing and Acceptance

Automated tests cover:

- AES-GCM round trip, wrong-key failure, changed-account AAD failure, redaction,
  and TOTP generation against published test vectors;
- additive SQLite migration and account-delete behavior;
- internal-token authorization and request validation;
- cookie replacement refusing invalid, unverified, or wrong-account sessions;
- state transitions, two-failure threshold, daily login-attempt limit, lock
  expiry, and notification deduplication;
- Feishu signature and safe message formatting;
- UI status rendering and action wiring;
- helper behavior using mocked browser pages for authenticated, email,
  password, TOTP, CAPTCHA, passkey, phone approval, and unknown states.

Docker smoke tests verify:

- both services become healthy;
- only loopback publishes noVNC;
- volumes survive `docker compose down` and recreation;
- browser-helper failure does not stop web2gem;
- a test profile can update a candidate cookie through the internal API;
- no credential or cookie value appears in logs or API responses.

Manual acceptance verifies:

- first noVNC login creates a persistent per-account profile;
- container recreation preserves SQLite and browser profiles;
- clipboard text works through the noVNC panel;
- an authenticated profile refreshes CK without password entry;
- a logged-out profile can complete email, password, and TOTP login;
- extra Google challenges stop automation and send one Feishu alert;
- manual recovery updates CK, refreshes model routing, and sends one recovery
  alert.

## 13. Deliberate Limits

The first version does not:

- solve CAPTCHA or bypass any Google security control;
- automate SMS, phone prompts, passkeys, recovery flows, or device approval;
- run multiple visible browser sessions concurrently;
- expose noVNC beyond host loopback;
- read the user's normal Windows Chrome or Edge profile;
- delete browser profiles automatically;
- migrate credentials from Cloudflare D1.

Existing account cookies may be exported and re-imported through supported
administration paths, but D1-to-SQLite migration tooling is a separate task.
