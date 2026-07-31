# Browser Helper Automatic Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second Docker container that maintains per-account Chromium profiles, renews validated Gemini cookies, performs bounded Google email/password/TOTP login, exposes a loopback-only noVNC session, and sends signed Feishu state notifications while web2gem remains the sole SQLite writer.

**Architecture:** `web2gem` owns SQLite, credential encryption, account identity checks, and all public/admin/internal APIs. `browser-helper` owns Chromium profiles and browser processes, communicates through an internal-token-protected API, and serializes all browser work. Candidate cookies replace stored cookies only after Gemini verification and either stable identity or a verified configured-email match.

**Tech Stack:** Node.js 26, TypeScript, Preact, SQLite (`node:sqlite`), Web Crypto AES-256-GCM, `playwright-core` with system Chromium, Xvfb, x11vnc, noVNC/websockify, Docker Compose, Vitest.

---

## File Map

New web2gem files:

- `migrations/0002_browser_helper.sql`: additive browser state and encrypted credential storage.
- `src/browser/types.ts`: shared safe DTOs, state names, and internal request types.
- `src/browser/credentials.ts`: credential validation, email hashing, AES-GCM encoding, and secret-safe errors.
- `src/browser/store.ts`: all browser metadata SQL; no browser code.
- `src/browser/candidate-cookie.ts`: candidate identity checks, Gemini verification, and atomic replacement orchestration.
- `src/http/internal/browser-helper.ts`: private helper API and timing-safe internal-token authentication.
- `src/http/admin/browser-accounts.ts`: admin credential, check, and visible-session endpoints.
- `server/secrets.mjs`: strict Docker Secret loading and master-key decoding.
- `server/credential-crypto.mjs`: server-only AES-GCM binding used by the
  bundled application without placing the master key in runtime config.
- `server/browser-helper-client.mjs`: bounded calls from web2gem admin routes to the helper control server.
- `browser-helper/config.mjs`: validated helper configuration.
- `browser-helper/web2gem-client.mjs`: authenticated private API client with redacted errors.
- `browser-helper/crypto.mjs`: AES-GCM decryption and TOTP generation.
- `browser-helper/google-login.mjs`: page classification and bounded login state machine.
- `browser-helper/chromium.mjs`: profile paths and Playwright Chromium lifecycle.
- `browser-helper/novnc.mjs`: Xvfb/x11vnc/websockify lifecycle.
- `browser-helper/scheduler.mjs`: jittered enabled-account queue, leases, and state transitions.
- `browser-helper/feishu.mjs`: signed, deduplicated webhook messages.
- `browser-helper/server.mjs`: private control and health HTTP server.
- `browser-helper/main.mjs`: process composition and shutdown.
- `Dockerfile.browser-helper`: browser-helper runtime image.

Existing files modified:

- `server/sqlite-binding.mjs`, `Dockerfile`: run/copy all ordered migrations and load secrets.
- `server/docker-server.mjs`: inject server-only credential and helper-client bindings.
- `src/config/types.ts`, `src/app.ts`: expose bindings and route private/admin browser requests.
- `src/gemini/accounts/types.ts`, `store-sql-runtime.ts`, `store-sql.ts`: add verified cookie replacement and safe browser status joins.
- `src/admin-ui/schemas.ts`, `types.ts`, `api.ts`, `actions.ts`, `state.ts`: safe browser DTOs and UI actions.
- `src/admin-ui/components/AccountActions.tsx`, `AccountRows.tsx`, `AccountCards.tsx`, `EditModal.tsx`: status, credential dialog, and browser controls.
- `src/admin-ui/i18n.ts`, `styles/components.css`, `styles/overlays.css`: labels and accessible presentation.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`: pin `playwright-core` for the helper.
- `compose.yaml`, `.env.docker.example`, `.gitignore`, `.dockerignore`: second service, secrets, ports, profiles, and safe defaults.
- `README.md`, `README.zh.md`, `scripts/docker-smoke.mjs`: deployment, rotation warning, backup, and smoke coverage.

## Task 1: Add Ordered SQLite Migrations and Browser Metadata

**Files:**
- Create: `migrations/0002_browser_helper.sql`
- Modify: `server/sqlite-binding.mjs`
- Modify: `Dockerfile`
- Test: `tests/unit/sqlite-binding.test.ts`

- [ ] **Step 1: Write failing migration tests**

Add tests that initialize a fresh file twice, assert `gemini_browser_accounts` exists, verify its `account_id` foreign key cascades, and ensure the original `pool_version` value survives the second startup. Use this exact state vocabulary:

```ts
const BROWSER_STATES = [
	"idle",
	"checking",
	"ready",
	"login_required",
	"manual_action_required",
	"error",
] as const;
```

Also test that migration discovery sorts `0001` before `0002` and rejects duplicate migration filenames.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `pnpm unit -- tests/unit/sqlite-binding.test.ts`

Expected: FAIL because only `0001_gemini_accounts.sql` is executed and the browser table does not exist.

- [ ] **Step 3: Add the migration**

Create `0002_browser_helper.sql` with this table shape:

```sql
CREATE TABLE IF NOT EXISTS gemini_browser_accounts (
  account_id TEXT PRIMARY KEY,
  credential_ciphertext TEXT,
  credential_nonce TEXT,
  credential_version INTEGER,
  login_email_hash TEXT,
  browser_state TEXT NOT NULL DEFAULT 'idle' CHECK (browser_state IN (
    'idle', 'checking', 'ready', 'login_required',
    'manual_action_required', 'error'
  )),
  last_check_at_ms INTEGER,
  last_cookie_update_at_ms INTEGER,
  last_auto_login_at_ms INTEGER,
  auth_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (auth_failure_count >= 0),
  auto_login_attempt_date TEXT,
  auto_login_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (auto_login_attempt_count >= 0),
  notification_state TEXT,
  failure_code TEXT,
  lock_owner TEXT,
  lock_expires_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES gemini_accounts(id) ON DELETE CASCADE,
  CHECK ((credential_ciphertext IS NULL AND credential_nonce IS NULL
    AND credential_version IS NULL AND login_email_hash IS NULL)
    OR (credential_ciphertext IS NOT NULL AND credential_nonce IS NOT NULL
      AND credential_version = 1 AND login_email_hash IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_gemini_browser_schedule
  ON gemini_browser_accounts (browser_state, last_check_at_ms, account_id);
```

Do not add credentials to `gemini_accounts`; keeping them in a separate table prevents existing account queries from accidentally selecting secrets.

- [ ] **Step 4: Load every ordered migration**

Replace the single migration read in `server/sqlite-binding.mjs` with `migrationFiles(directory)`, sorting filenames matching `/^\d{4}_[a-z0-9_]+\.sql$/`, and execute every file inside one startup transaction:

```js
database.exec("BEGIN IMMEDIATE");
for (const migration of migrationFiles(migrationsDir)) {
	database.exec(readFileSync(migration, "utf8"));
}
database.exec("COMMIT");
```

Rollback on failure before closing the database. Keep the existing `migrationSql` test override for focused binding tests. Change the Docker build to copy the whole `migrations` directory rather than one file.

- [ ] **Step 5: Run migration tests and static checks**

Run: `pnpm unit -- tests/unit/sqlite-binding.test.ts && pnpm typecheck:tests`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/0002_browser_helper.sql server/sqlite-binding.mjs Dockerfile tests/unit/sqlite-binding.test.ts
git commit -m "feat: add browser account metadata migration"
```

## Task 2: Implement Master-Key Loading and Credential Cryptography

**Files:**
- Create: `server/secrets.mjs`
- Create: `server/credential-crypto.mjs`
- Create: `src/browser/credentials.ts`
- Create: `src/browser/types.ts`
- Modify: `server/docker-server.mjs`
- Modify: `src/config/types.ts`
- Test: `tests/unit/browser/credentials.test.ts`
- Test: `tests/unit/docker-server.test.ts`

- [ ] **Step 1: Write failing crypto tests**

Cover AES-GCM round trip, random nonce uniqueness, wrong-key failure, changed-account AAD failure, invalid base32 TOTP seed rejection, canonical lower-case email hashing, maximum lengths, and errors that never contain supplied secrets. Use this payload contract:

```ts
type BrowserCredentials = {
	email: string;
	password: string;
	totpSecret: string;
};

type EncryptedBrowserCredentials = {
	version: 1;
	ciphertext: string;
	nonce: string;
	emailHash: string;
};
```

Limits: email 320 UTF-8 bytes, password 1024 UTF-8 bytes, normalized base32 seed 256 characters.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm unit -- tests/unit/browser/credentials.test.ts tests/unit/docker-server.test.ts`

Expected: FAIL because the secret loader and credential module do not exist.

- [ ] **Step 3: Implement strict secret loading**

`server/secrets.mjs` must read `/run/secrets/web2gem_master_key` or the injected test path, trim one trailing newline, decode exactly 32 bytes from base64, and return `null` when the file is absent. Invalid existing files throw `browser master key must decode to exactly 32 bytes`; never generate a replacement key.

Create the binding in `server/credential-crypto.mjs` and inject it rather than
the raw key:

```js
nextEnv.BROWSER_CREDENTIAL_CRYPTO = createCredentialCryptoBinding(masterKey);
nextEnv.BROWSER_HELPER_CLIENT = createBrowserHelperClient(sourceEnv);
```

Extend `AppEnv` typing with optional opaque methods; do not add the key to `RuntimeConfig`.

- [ ] **Step 4: Implement AES-GCM and validation**

In `credentials.ts`, normalize email with `trim().toLowerCase()`, remove spaces and hyphens from the base32 seed, validate `/^[A-Z2-7]+=*$/`, and encrypt JSON with:

```ts
const additionalData = new TextEncoder().encode(`web2gem:${accountId}:v1`);
const ciphertext = await crypto.subtle.encrypt(
	{ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
	key,
	new TextEncoder().encode(JSON.stringify(credentials)),
);
```

Encode nonce and ciphertext as base64. `emailHash` is SHA-256 of the canonical
email. `src/browser/credentials.ts` owns input validation and calls the opaque
server binding; `server/credential-crypto.mjs` owns the actual key and Web
Crypto calls. Expose only `encrypt(accountId, credentials)` and
`decrypt(accountId, encrypted)` on the binding.

- [ ] **Step 5: Run tests and checks**

Run: `pnpm unit -- tests/unit/browser/credentials.test.ts tests/unit/docker-server.test.ts && pnpm typecheck && pnpm typecheck:tests`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/secrets.mjs server/credential-crypto.mjs server/docker-server.mjs src/browser src/config/types.ts tests/unit/browser tests/unit/docker-server.test.ts
git commit -m "feat: encrypt browser login credentials"
```

## Task 3: Add Browser Metadata Store and Safe Account DTOs

**Files:**
- Create: `src/browser/store.ts`
- Modify: `src/gemini/accounts/types.ts`
- Modify: `src/gemini/accounts/store-sql.ts`
- Modify: `src/gemini/accounts/store-sql-runtime.ts`
- Test: `tests/unit/browser/store.test.ts`
- Test: `tests/unit/gemini/accounts/store-admin.test.ts`

- [ ] **Step 1: Write failing store tests**

Test these operations against `RecordingSql` and one real in-memory SQLite binding:

```ts
interface BrowserAccountStore {
	listScheduled(nowMs: number): Promise<BrowserScheduleAccount[]>;
	getStatus(accountId: string): Promise<BrowserAccountStatus | null>;
	putCredentials(accountId: string, value: EncryptedBrowserCredentials, nowMs: number): Promise<void>;
	clearCredentials(accountId: string, nowMs: number): Promise<void>;
	getEncryptedCredentials(accountId: string): Promise<EncryptedBrowserCredentials | null>;
	tryAcquireLease(accountId: string, owner: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
	releaseLease(accountId: string, owner: string): Promise<void>;
	writeStatus(accountId: string, update: BrowserStatusUpdate): Promise<void>;
	recordAutoLoginAttempt(accountId: string, date: string, nowMs: number): Promise<number>;
}
```

Assert that safe admin account summaries contain `browser` status but never ciphertext, nonce, hashes, cookies, or tokens.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm unit -- tests/unit/browser/store.test.ts tests/unit/gemini/accounts/store-admin.test.ts`

Expected: FAIL because browser SQL and DTO fields are absent.

- [ ] **Step 3: Implement the store**

Use upserts that create a metadata row on first operation. Lease acquisition must succeed only when `lock_expires_at_ms IS NULL OR lock_expires_at_ms <= nowMs OR lock_owner = owner`. `recordAutoLoginAttempt` resets the count when the date bucket changes and returns the new count atomically.

Define the public safe status exactly as:

```ts
type BrowserAccountStatus = {
	credentialsConfigured: boolean;
	state: BrowserState;
	lastCheckAtMs: number | null;
	lastCookieUpdateAtMs: number | null;
	lastAutoLoginAtMs: number | null;
	failureCode: string | null;
};
```

Left join this status into admin account summaries, defaulting missing rows to `credentialsConfigured: false`, `state: "idle"`, and null timestamps.

- [ ] **Step 4: Run tests and type checks**

Run: `pnpm unit -- tests/unit/browser/store.test.ts tests/unit/gemini/accounts/store-admin.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/browser/store.ts src/browser/types.ts src/gemini/accounts tests/unit/browser/store.test.ts tests/unit/gemini/accounts/store-admin.test.ts
git commit -m "feat: persist browser account state"
```

## Task 4: Add Verified Candidate-Cookie Replacement

**Files:**
- Create: `src/browser/candidate-cookie.ts`
- Modify: `src/gemini/accounts/types.ts`
- Modify: `src/gemini/accounts/store-sql-runtime.ts`
- Modify: `src/gemini/accounts/pool.ts`
- Test: `tests/unit/browser/candidate-cookie.test.ts`
- Test: `tests/unit/gemini/accounts/store-runtime.test.ts`

- [ ] **Step 1: Write failing identity and verification tests**

Cover: unchanged cookie; same identity with changed cookie; changed identity with matching configured email hash; changed identity without credentials; changed identity with wrong email; duplicate cookie/identity unique conflict; Gemini probe failure; and successful model capability refresh. No failed case may mutate the stored cookie.

The command input is:

```ts
type CandidateCookieInput = {
	accountId: string;
	psid: string;
	psidts: string;
	observedEmail: string | null;
	nowMs: number;
};
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm unit -- tests/unit/browser/candidate-cookie.test.ts tests/unit/gemini/accounts/store-runtime.test.ts`

Expected: FAIL because direct verified replacement does not exist.

- [ ] **Step 3: Implement validation before mutation**

Build the normalized two-cookie header, compute cookie and identity hashes, and create a candidate account config. Verify with `verifyGeminiAccount({ level: "status" })`. Reject missing page token, restricted account status, and probe failure before SQL mutation.

When identity changes, require `observedEmail` and compare its canonical SHA-256 to stored `login_email_hash` using timing-safe byte comparison. Return safe codes such as `browser_identity_mismatch`, never observed email or cookie values.

- [ ] **Step 4: Implement atomic replacement**

Add `replaceVerifiedBrowserCookie` to the store. In one batch, update `cookie_header`, `cookie_hash`, `identity_hash`, refresh timestamps, clear durable auth issue/cooldown, upsert the probe models, update browser success state, and increment `pool_version`. Map unique constraint failures to `browser_cookie_conflict`.

- [ ] **Step 5: Run focused and account-pool tests**

Run: `pnpm unit -- tests/unit/browser/candidate-cookie.test.ts tests/unit/gemini/accounts/store-runtime.test.ts tests/unit/gemini/accounts/pool-catalog.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/browser/candidate-cookie.ts src/gemini/accounts tests/unit/browser/candidate-cookie.test.ts tests/unit/gemini/accounts/store-runtime.test.ts
git commit -m "feat: validate browser cookies before replacement"
```

## Task 5: Expose the Private Browser-Helper API

**Files:**
- Create: `src/http/internal/browser-helper.ts`
- Modify: `src/app.ts`
- Modify: `src/config/types.ts`
- Test: `tests/unit/http/internal/browser-helper.contract.test.ts`

- [ ] **Step 1: Write failing contract tests**

Test that private routes reject missing/wrong tokens before SQL access, enforce JSON body limits, reject unknown fields, redact errors, and support only:

```text
GET    /internal/browser/accounts
POST   /internal/browser/accounts/:id/lease
DELETE /internal/browser/accounts/:id/lease
GET    /internal/browser/accounts/:id/credentials
PATCH  /internal/browser/accounts/:id/state
POST   /internal/browser/accounts/:id/candidate-cookie
```

Authentication uses `Authorization: Bearer <BROWSER_HELPER_INTERNAL_TOKEN>` and timing-safe comparison. These routes must not accept `ADMIN_KEY`.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm unit -- tests/unit/http/internal/browser-helper.contract.test.ts`

Expected: FAIL because private routing is absent.

- [ ] **Step 3: Implement the handler and route registration**

Register private routes before public API authentication but let the handler own its stronger internal auth. `GET /accounts` returns enabled account IDs, labels, safe status, and schedule timestamps. The credential route returns encrypted fields only. Candidate-cookie delegates to Task 4 and returns `{ changed, state, lastCookieUpdateAtMs }`.

Bound failure codes to `/^[a-z0-9_]{1,64}$/`; bound lease owner to 128 characters and lease TTL to 30-600 seconds.

- [ ] **Step 4: Run tests and checks**

Run: `pnpm unit -- tests/unit/http/internal/browser-helper.contract.test.ts && pnpm typecheck && pnpm check:static`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/internal src/app.ts src/config/types.ts tests/unit/http/internal
git commit -m "feat: add private browser helper API"
```

## Task 6: Add Admin Credential and Browser Commands

**Files:**
- Create: `src/http/admin/browser-accounts.ts`
- Create: `server/browser-helper-client.mjs`
- Modify: `server/docker-server.mjs`
- Modify: `src/app.ts`
- Test: `tests/unit/http/admin/browser-accounts.contract.test.ts`
- Test: `tests/unit/browser/credentials.test.ts`

- [ ] **Step 1: Write failing admin-route tests**

Cover admin authentication, master-key-unavailable fail-closed behavior, first
credential configuration, partial credential update with blank-field
preservation, incomplete first configuration rejection, clearing credentials,
immediate check, visible open, and visible stop:

```text
PUT    /admin/accounts/:id/browser/credentials
DELETE /admin/accounts/:id/browser/credentials
POST   /admin/accounts/:id/browser/check
POST   /admin/accounts/:id/browser/open
DELETE /admin/accounts/:id/browser/profile
POST   /admin/browser/stop
```

The body accepts `{ email, password, totpSecret }` strings. First configuration
requires all three non-empty values. When credentials already exist, each blank
value preserves the corresponding decrypted old value and each non-empty value
replaces it. Responses contain only `credentialsConfigured` and safe browser
status.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm unit -- tests/unit/http/admin/browser-accounts.contract.test.ts`

Expected: FAIL because routes and helper client are missing.

- [ ] **Step 3: Implement credentials endpoints**

Encrypt through `BROWSER_CREDENTIAL_CRYPTO` and store via
`BrowserAccountStore`. For an update, fetch and decrypt the current version,
merge only non-empty input fields, validate the complete merged object, and
encrypt it with a fresh nonce. Overwrite both request and decrypted objects with
empty strings in a `finally` block to shorten plaintext lifetime. Clearing is an
explicit DELETE. Return `503 browser_master_key_unavailable` when the secret
binding is absent without deleting ciphertext.

- [ ] **Step 4: Implement bounded helper control calls**

`browser-helper-client.mjs` sends internal-token-authenticated requests to the Compose hostname with a 15-second timeout and a 64 KiB response limit. It exposes:

```js
{ checkNow(accountId), openVisible(accountId), stopVisible(), deleteProfile(accountId) }
```

Map connection failure to `browser_helper_unavailable`. `openVisible` returns only `{ url }`, where the URL comes from validated `NOVNC_PUBLIC_URL`; it must not contain a password or token.

Add `deleteProfile(accountId)` to the helper client. The admin route requires an
explicit `{ confirmAccountId }` body equal to the path account ID. It deletes no
SQLite row or cookie; it only asks browser-helper to remove the inactive
profile.

- [ ] **Step 5: Run contract and server tests**

Run: `pnpm unit -- tests/unit/http/admin/browser-accounts.contract.test.ts tests/unit/docker-server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http/admin/browser-accounts.ts src/app.ts server/browser-helper-client.mjs server/docker-server.mjs tests/unit/http/admin tests/unit/docker-server.test.ts
git commit -m "feat: add browser account admin commands"
```

## Task 7: Build Helper Crypto, API Client, and Feishu Notifications

**Files:**
- Create: `browser-helper/config.mjs`
- Create: `browser-helper/crypto.mjs`
- Create: `browser-helper/web2gem-client.mjs`
- Create: `browser-helper/feishu.mjs`
- Test: `tests/unit/browser-helper/config.test.ts`
- Test: `tests/unit/browser-helper/crypto.test.ts`
- Test: `tests/unit/browser-helper/feishu.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing helper-module tests**

Test configuration bounds, master-key decoding, AES-GCM decryption, RFC 6238
SHA-1 six-digit TOTP vectors, previous/current/next step candidates, Feishu
signatures, state-transition deduplication, retry bounds, and secret-free
exceptions.

Generate Feishu signatures as required by the custom bot protocol:

```js
const stringToSign = `${timestamp}\n${secret}`;
const sign = createHmac("sha256", stringToSign)
	.update("")
	.digest("base64");
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm unit -- tests/unit/browser-helper`

Expected: FAIL because helper modules do not exist.

- [ ] **Step 3: Implement configuration and private client**

Validate defaults: interval `21600`, jitter up to one hour, maximum automatic login attempts `2`, visible idle timeout `1800`, helper port `6081`. Require internal URL and token. Treat Feishu configuration as disabled unless both URL and signing secret are present.

The private client must set timeouts, cap bodies, parse only JSON, and replace upstream details with safe local codes. It must never include authorization headers or response bodies in thrown messages.

- [ ] **Step 4: Implement decryption and TOTP**

Use only `node:crypto`; do not add a TOTP dependency. Decode base32 locally, compute `HMAC-SHA1(floor(unixSeconds / 30))`, dynamic truncate, and zero-pad modulo 1,000,000. Refuse local clock values more than the configured skew from a server `Date` sample when one is available.

- [ ] **Step 5: Implement signed notification transitions**

Send only account label, last six account-ID characters, safe failure category, ISO timestamp, noVNC URL, and action. Retry network/5xx failure at 1, 5, and 30 seconds; do not retry 4xx. Persist dedupe state through the private state endpoint only after successful delivery.

- [ ] **Step 6: Run tests**

Run: `pnpm unit -- tests/unit/browser-helper && pnpm typecheck:tests`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add browser-helper/config.mjs browser-helper/crypto.mjs browser-helper/web2gem-client.mjs browser-helper/feishu.mjs tests/unit/browser-helper package.json pnpm-lock.yaml
git commit -m "feat: add browser helper security services"
```

## Task 8: Implement Chromium Profile and Google Login State Machine

**Files:**
- Create: `browser-helper/chromium.mjs`
- Create: `browser-helper/google-login.mjs`
- Test: `tests/unit/browser-helper/chromium.test.ts`
- Test: `tests/unit/browser-helper/google-login.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Pin Playwright Core**

Run: `pnpm add playwright-core@1.62.1 --save-exact`

Expected: `package.json` and `pnpm-lock.yaml` contain the exact
`playwright-core@1.62.1` runtime dependency. Do not download
Playwright-managed browsers; the container supplies Chromium. If the system
Chromium in the selected base image is incompatible with this protocol version,
stop and pin a matching Chromium package/base image pair in this task rather
than loosening the Node dependency to a range.

- [ ] **Step 2: Write failing profile and page-state tests**

Test that profile paths are `sha256(accountId)` directories beneath `/profiles`, traversal input cannot escape, only one process owns a profile, and cleanup closes contexts.

With a fake Page adapter, test these page states:

```js
"authenticated" | "email" | "password" | "totp" |
"captcha" | "passkey" | "phone_approval" | "recovery" |
"device_confirmation" | "unknown"
```

Explicit challenge states must always stop without form submission.

- [ ] **Step 3: Run tests and verify failure**

Run: `pnpm unit -- tests/unit/browser-helper/chromium.test.ts tests/unit/browser-helper/google-login.test.ts`

Expected: FAIL because lifecycle and classifier modules do not exist.

- [ ] **Step 4: Implement Chromium lifecycle**

Use `chromium.launchPersistentContext(profilePath, { executablePath: "/usr/bin/chromium", headless, proxy, args })`. Include `--no-first-run`, `--disable-dev-shm-usage`, and container-safe sandbox settings; do not disable web security. Provide `startHeadless`, `startVisible`, `cookies`, and `close` methods behind a single active-context guard.

- [ ] **Step 5: Implement bounded login states**

Classify by Google challenge URL plus visible semantic form controls. Submit at most once per state transition. Handle only email, password, and TOTP; use the current/previous/next TOTP candidates at most once each. Require final navigation to Gemini, two required cookies, and a reliably observed account email before reporting login success.

Return safe results:

```js
{ ok: true, psid, psidts, observedEmail, automaticLoginUsed }
{ ok: false, code: "captcha" | "passkey" | "phone_approval" |
  "recovery" | "device_confirmation" | "unknown_page" |
  "missing_cookie" | "login_failed" }
```

- [ ] **Step 6: Run tests and checks**

Run: `pnpm unit -- tests/unit/browser-helper/chromium.test.ts tests/unit/browser-helper/google-login.test.ts && pnpm check:static`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add browser-helper/chromium.mjs browser-helper/google-login.mjs tests/unit/browser-helper package.json pnpm-lock.yaml
git commit -m "feat: automate bounded Gemini browser login"
```

## Task 9: Implement Scheduler, Leases, and Failure Transitions

**Files:**
- Create: `browser-helper/scheduler.mjs`
- Test: `tests/unit/browser-helper/scheduler.test.ts`

- [ ] **Step 1: Write failing scheduler tests**

Use fake time and injected browser/client functions to cover jitter, enabled-only scheduling, one global job, manual-job priority, lease conflict, stale lease recovery, unchanged-cookie success, two transient auth failures, explicit challenge immediate manual state, daily automatic-login limit, recovery notification, and clean shutdown.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm unit -- tests/unit/browser-helper/scheduler.test.ts`

Expected: FAIL because scheduler does not exist.

- [ ] **Step 3: Implement one queue and one account job**

The queue accepts `{ accountId, mode: "scheduled" | "manual_check" | "visible" }`, deduplicates pending account jobs, and prioritizes visible/manual work. Each maintenance job:

```text
acquire lease -> mark checking -> inspect profile -> optional bounded login
-> submit candidate -> mark ready/error/manual -> notify transition
-> close headless Chromium -> release lease
```

Network, proxy, DNS, and timeout errors set `error` but do not increment authentication failures or start automatic login. Missing cookies twice set `login_required`; explicit challenge states set `manual_action_required` immediately.

- [ ] **Step 4: Run tests**

Run: `pnpm unit -- tests/unit/browser-helper/scheduler.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add browser-helper/scheduler.mjs tests/unit/browser-helper/scheduler.test.ts
git commit -m "feat: schedule browser session maintenance"
```

## Task 10: Add Xvfb, noVNC, and the Helper Control Server

**Files:**
- Create: `browser-helper/novnc.mjs`
- Create: `browser-helper/server.mjs`
- Create: `browser-helper/main.mjs`
- Test: `tests/unit/browser-helper/novnc.test.ts`
- Test: `tests/unit/browser-helper/server.test.ts`

- [ ] **Step 1: Write failing process and HTTP tests**

Inject `spawn` and verify exact process arguments, password-file permissions, cleanup order, readiness failures, one visible session, account switching confirmation code, control token authentication, 64 KiB body limit, and health output.

Private helper routes are:

```text
GET  /health
POST /checks/:accountId
POST /sessions/:accountId/open
POST /sessions/stop
DELETE /profiles/:accountId
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm unit -- tests/unit/browser-helper/novnc.test.ts tests/unit/browser-helper/server.test.ts`

Expected: FAIL because noVNC and server modules do not exist.

- [ ] **Step 3: Implement display and clipboard services**

Start Xvfb on `:99`, x11vnc on loopback port 5900 with an owner-only password file, then `websockify --web /usr/share/novnc 6080 127.0.0.1:5900`. noVNC's standard clipboard panel remains enabled. Never place the VNC password in process arguments or returned URLs.

- [ ] **Step 4: Implement visible session ownership**

Before opening a profile visibly, wait for its headless job to finish, acquire its lease, start the display stack, and launch visible Chromium. Refuse a second account with `409 visible_session_conflict`; the admin UI must explicitly stop the first session before retrying. On stop or idle timeout, perform one final cookie check before closing and releasing the lease.

Profile deletion requires the control token, rejects an active or queued account
with `409 profile_busy`, resolves only the SHA-256-derived directory beneath
`/profiles`, and uses a non-following recursive removal. It is never called by
account deletion or container shutdown.

- [ ] **Step 5: Compose the helper process**

`main.mjs` loads configuration and the master key, creates clients/services, starts the scheduler and control server, and handles `SIGINT`/`SIGTERM` in this order: stop accepting HTTP, stop scheduler, close Chromium, stop noVNC/x11vnc/Xvfb.

- [ ] **Step 6: Run tests**

Run: `pnpm unit -- tests/unit/browser-helper/novnc.test.ts tests/unit/browser-helper/server.test.ts tests/unit/browser-helper/scheduler.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add browser-helper/novnc.mjs browser-helper/server.mjs browser-helper/main.mjs tests/unit/browser-helper
git commit -m "feat: expose managed noVNC browser sessions"
```

## Task 11: Add Administration UI Controls

**Files:**
- Modify: `src/admin-ui/schemas.ts`
- Modify: `src/admin-ui/types.ts`
- Modify: `src/admin-ui/api.ts`
- Modify: `src/admin-ui/actions.ts`
- Modify: `src/admin-ui/state.ts`
- Modify: `src/admin-ui/components/AccountActions.tsx`
- Modify: `src/admin-ui/components/AccountRows.tsx`
- Modify: `src/admin-ui/components/AccountCards.tsx`
- Create: `src/admin-ui/components/BrowserCredentialsModal.tsx`
- Modify: `src/admin-ui/app.tsx`
- Modify: `src/admin-ui/i18n.ts`
- Modify: `src/admin-ui/styles/components.css`
- Modify: `src/admin-ui/styles/overlays.css`
- Test: `tests/unit/admin-ui/schemas.test.ts`
- Test: `tests/unit/admin-ui/api-browser.test.ts`
- Test: `tests/unit/admin-ui/actions-browser.test.ts`

- [ ] **Step 1: Write failing strict-schema and API tests**

Extend the strict account schema with the safe `browser` object from Task 3.
Assert secret fields are rejected. Test exact methods and paths for configure,
clear, check, open, stop, and profile deletion.

- [ ] **Step 2: Write failing action tests for popup-safe open**

On click, call `window.open("about:blank", "_blank", "noopener")`
synchronously, render a localized waiting message in that tab, request
`/browser/open`, then assign the validated same-host/loopback noVNC URL. On
`visible_session_conflict`, close the waiting tab, ask the user to confirm
stopping the current account session, call `/admin/browser/stop`, and repeat
the open action only after confirmation. On other errors, close the waiting
tab and show a toast. Never append a VNC password.

- [ ] **Step 3: Run focused tests and verify failure**

Run: `pnpm unit -- tests/unit/admin-ui/schemas.test.ts tests/unit/admin-ui/api-browser.test.ts tests/unit/admin-ui/actions-browser.test.ts`

Expected: FAIL because browser fields and actions are absent.

- [ ] **Step 4: Implement safe API and state actions**

Add functions:

```ts
configureBrowserCredentials(session, accountId, { email, password, totpSecret })
clearBrowserCredentials(session, accountId)
checkBrowserNow(session, accountId)
openAccountBrowser(session, accountId)
stopAccountBrowser(session)
deleteAccountBrowserProfile(session, accountId)
```

Credential values live only in local component state and are cleared in `finally`. Do not place them in signals shared with account lists or browser storage.

- [ ] **Step 5: Implement accessible UI**

Add browser state text, configured/not-configured badge, last check time,
`Configure login`, `Clear credentials`, `Check now`, `Open browser`, and
`Delete browser profile`. The modal uses `type="email"`, `type="password"`,
autocomplete values `username`, `current-password`, and `one-time-code`,
explains that the third value is the authenticator seed rather than a six-digit
code, and requires explicit confirmation before clearing. Profile deletion
uses a separate destructive confirmation that includes the account label and
states that stored SQLite CK and encrypted credentials are retained.

Preserve existing responsive row/card layouts and keyboard focus behavior. Busy state disables only conflicting actions on the same account.

- [ ] **Step 6: Run UI tests and static checks**

Run: `pnpm unit -- tests/unit/admin-ui && pnpm typecheck && pnpm check:static`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/admin-ui tests/unit/admin-ui
git commit -m "feat: manage browser login from admin UI"
```

## Task 12: Build the Browser Image and Compose Deployment

**Files:**
- Create: `Dockerfile.browser-helper`
- Modify: `compose.yaml`
- Modify: `.env.docker.example`
- Modify: `.gitignore`
- Modify: `.dockerignore`
- Test: `tests/unit/scripts.test.ts`

- [ ] **Step 1: Write failing deployment-file tests**

Assert two services, a private Compose network, `127.0.0.1:${NOVNC_PORT:-6080}:6080`, separate data/profile volumes, read-only master-key secret mounts, helper healthcheck, no SQLite volume in browser-helper, no profile volume in web2gem, and no literal credential/webhook/secret values.

- [ ] **Step 2: Run deployment tests and verify failure**

Run: `pnpm unit -- tests/unit/scripts.test.ts`

Expected: FAIL because browser-helper deployment files are absent.

- [ ] **Step 3: Create the browser-helper image**

Use `m.daocloud.io/docker.io/library/node:26-bookworm-slim`, matching the
already required Node 26 runtime while avoiding the Docker Hub connectivity
problem observed during deployment. Install only Chromium, Xvfb, x11vnc,
noVNC, websockify, CA certificates, `fonts-noto-cjk`, and `tini`; remove package
indexes. Create a non-root `browser` user, own `/profiles` and runtime
directories, copy production Node dependencies and `browser-helper`, and start
through `tini`.

Do not bake proxy, login, VNC, Feishu, admin, or internal-token values into the image.

- [ ] **Step 4: Extend Compose**

Add `browser-helper`, `browser-profiles`, a private `browser-internal` network, and the master-key secret. Keep `web2gem` as the only service publishing the API port. Publish noVNC on loopback only. Pass the same proxy variables to both services, and set `NO_PROXY` for Compose service names and loopback.

Add environment placeholders but no values for internal token, noVNC password, Feishu webhook/signing secret, public noVNC URL, intervals, and limits.

- [ ] **Step 5: Protect local secrets**

Ignore `secrets/`, Chromium profiles, SQLite copies, screenshots, and helper runtime files in Git and Docker contexts. Document generating the master key locally; never create it during container startup.

- [ ] **Step 6: Validate Compose and build**

Run: `docker compose config --quiet`

Expected: exit 0 with configured local secret files.

Run: `docker compose build web2gem browser-helper`

Expected: both images build successfully.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile.browser-helper compose.yaml .env.docker.example .gitignore .dockerignore tests/unit/scripts.test.ts
git commit -m "feat: deploy browser helper beside web2gem"
```

## Task 13: Add End-to-End Redaction, Failure, and Persistence Coverage

**Files:**
- Modify: `scripts/docker-smoke.mjs`
- Create: `tests/integration/browser-helper-flow.test.ts`
- Modify: `vitest.config.mjs`

- [ ] **Step 1: Write an integration test with a fake browser adapter**

Start real SQLite and application handlers with a fake helper browser. Exercise: configure encrypted credentials; retrieve ciphertext through internal auth; simulate authenticated cookies; verify atomic CK update; simulate CAPTCHA; verify one Feishu notification; recover; verify one recovery notification; and confirm every HTTP response/log capture excludes the test password, TOTP seed, cookies, master key, internal token, and webhook secret.

- [ ] **Step 2: Run integration test and fix only boundary defects**

Run: `pnpm unit -- tests/integration/browser-helper-flow.test.ts`

Expected: PASS. Any failure must be fixed at the owning boundary (crypto, store, internal API, scheduler, or notification), not patched in the test.

- [ ] **Step 3: Extend Docker smoke coverage**

Have `scripts/docker-smoke.mjs` start the Compose stack with temporary generated secrets and mock Gemini/Feishu endpoints. Verify both healthchecks, loopback noVNC mapping, helper restart independence, browser profile persistence, SQLite persistence after recreation, and secret-free logs. The smoke must clean only resources it created and must not use `docker compose down -v` against the user's normal project.

- [ ] **Step 4: Run the smoke test**

Run: `pnpm docker:smoke`

Expected: `Docker smoke check passed`.

- [ ] **Step 5: Commit**

```bash
git add scripts/docker-smoke.mjs tests/integration vitest.config.mjs
git commit -m "test: cover browser helper recovery flow"
```

## Task 14: Document Secure Setup, Rotation, and Operations

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `.env.docker.example`

- [ ] **Step 1: Add exact Windows CMD setup instructions**

Document generating a 32-byte base64 master key without printing it to chat, creating `secrets\web2gem_master_key`, generating distinct `ADMIN_KEY`, internal token, and noVNC password, configuring the rotated Feishu webhook/signing secret in `.env`, and starting both services with:

```cmd
cd /d D:\web2gem-original
docker compose up -d --build
docker compose ps
```

Do not reproduce the webhook or signing secret disclosed in conversation.

- [ ] **Step 2: Document operations and recovery**

Explain `http://127.0.0.1:18080/admin`, loopback noVNC, its clipboard panel, one visible account at a time, six-hour checks, two automatic login attempts per day, challenge handoff, Feishu transition alerts, proxy propagation, and safe credential clearing.

State explicitly that Google automation is best effort and does not solve CAPTCHA, passkeys, phone prompts, recovery, or security review.

- [ ] **Step 3: Document backup and key-loss behavior**

Back up both named volumes and the master-key file together. Explain that losing the key makes encrypted login credentials unrecoverable but does not delete SQLite account cookies or profiles. Warn that `docker compose down -v` deletes both persistent volumes.

- [ ] **Step 4: Run documentation and release checks**

Run: `pnpm check:static && pnpm check:release`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh.md .env.docker.example
git commit -m "docs: explain browser-assisted account renewal"
```

## Task 15: Final Verification

**Files:** No planned source changes.

- [ ] **Step 1: Run the complete quality suite**

```bash
pnpm check:static
pnpm typecheck
pnpm typecheck:tests
pnpm check:test-types
pnpm check:arch
pnpm unit
pnpm build
pnpm smoke
```

Expected: every command exits 0.

- [ ] **Step 2: Run Docker verification**

```bash
docker compose config --quiet
docker compose build web2gem browser-helper
pnpm docker:smoke
```

Expected: Compose validates, both images build, and smoke passes.

- [ ] **Step 3: Inspect secret exposure and image contents**

Run repository searches for the test password, seed, internal token, webhook value, and private cookie fixtures; verify only intentional test literals exist. Inspect `docker compose config` and container logs with secrets masked. Confirm no secret file is present in either image layer and no host port other than API and loopback noVNC is published.

- [ ] **Step 4: Review Git scope**

Run: `git status --short && git log --oneline --decorate -20`

Expected: clean worktree and the task commits above in order. Do not amend or squash without explicit user request.

- [ ] **Step 5: Perform manual acceptance**

Configure one test account, open its visible browser, verify clipboard text, complete a normal profile login, run `Check now`, confirm CK/model routing refresh, sign the profile out, confirm bounded password/TOTP login, and use a controlled manual-action page fixture to verify one Feishu alert and one recovery alert. Rotate any real credentials used during acceptance.
