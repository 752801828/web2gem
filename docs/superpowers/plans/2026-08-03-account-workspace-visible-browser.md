# Account Workspace And Visible Browser Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically finish visible Gemini login sessions after authentication, integrate account import into the account workspace, and make every row action visible inside the scrolling table.

**Architecture:** Keep the existing scheduler, final cookie validation, import actions, and native `details` menus. Add a read-only authentication observer at the visible-session boundary, move the existing import disclosure into `Workspace`, and override only row menus to expand in normal table flow while leaving the bulk menu floating.

**Tech Stack:** Node.js 26, Preact, TypeScript, CSS, Vitest, Playwright Core, Docker Compose

---

### Task 1: Preserve The Existing Empty-POST Adapter Fix

**Files:**
- Modify: `server/docker-server.mjs`
- Test: `tests/unit/docker-server.test.ts`

- [ ] **Step 1: Verify the focused adapter regression tests**

Run:

```powershell
pnpm exec vitest run tests/unit/docker-server.test.ts
```

Expected: 13 tests pass, including empty `POST` requests with `Content-Length: 0` and without body framing headers.

- [ ] **Step 2: Commit only the existing adapter fix**

```powershell
git add server/docker-server.mjs tests/unit/docker-server.test.ts
git commit -m "fix: preserve empty Docker admin requests"
```

Expected: the working tree contains no remaining changes to those two files.

### Task 2: Complete Visible Sessions When Gemini Authentication Appears

**Files:**
- Modify: `browser-helper/google-login.mjs`
- Modify: `browser-helper/main.mjs`
- Modify: `browser-helper/server.mjs`
- Test: `tests/unit/browser-helper/google-login.test.ts`
- Test: `tests/unit/browser-helper/main.test.ts`
- Test: `tests/unit/browser-helper/server.test.ts`

- [ ] **Step 1: Write a failing coordinator test for automatic completion**

Add a visible-session test that injects an authentication observer and resolves it after `open()` returns:

```ts
test("finishes a visible session when Gemini authentication becomes observable", async () => {
  let authenticated!: () => void;
  const observed = new Promise<void>((resolve) => {
    authenticated = resolve;
  });
  // Build the existing scheduler/coordinator fixture with:
  // waitForAuthentication: async () => observed
  await coordinator.open("account-a");
  authenticated();
  await coordinator.waitForIdle();
  assert.deepEqual(calls, ["novnc-start", "final-check", "novnc-stop"]);
  assert.equal(coordinator.isActive("account-a"), false);
});
```

- [ ] **Step 2: Write failing stop and observer-error tests**

Add tests proving that manual stop still performs exactly one final check, abort performs none, and a rejected authentication observation does not strand the session:

```ts
await coordinator.open("account-a");
rejectObservation(new Error("transient page inspection"));
await coordinator.stop();
assert.equal(finalChecks, 1);
assert.equal(coordinator.isActive("account-a"), false);
```

- [ ] **Step 3: Run the coordinator tests and verify RED**

```powershell
pnpm exec vitest run tests/unit/browser-helper/server.test.ts
```

Expected: the new tests fail because `waitForAuthentication` is not consumed.

- [ ] **Step 4: Add a read-only Gemini authentication waiter**

In `browser-helper/google-login.mjs`, export a waiter that reuses `classifyGooglePage`, ignores transient inspection errors, and exits on abort:

```js
export async function waitForGoogleAuthentication(
  page,
  signal,
  { pollMs = 1_000, wait = abortableDelay } = {},
) {
  while (!signal?.aborted) {
    try {
      if ((await classifyGooglePage(page)) === "authenticated") return;
    } catch {
      // The page may be navigating between trusted Google screens.
    }
    await wait(pollMs, signal);
  }
  throw signal.reason instanceof Error ? signal.reason : new Error("authentication observation aborted");
}
```

The abortable delay must clear its timer when `signal` aborts so stopped sessions leave no live polling timer.

- [ ] **Step 5: Unit-test the waiter**

Add tests with the existing page adapter fixture proving:

```ts
assert.equal(checks, 2); // unknown first, authenticated second
await assert.rejects(waitForGoogleAuthentication(page, aborted.signal), /aborted/);
```

Run:

```powershell
pnpm exec vitest run tests/unit/browser-helper/google-login.test.ts
```

Expected: the new authentication waiter tests pass.

- [ ] **Step 6: Race authentication against stop and lease abort**

In `createVisibleSessionCoordinator`, accept `waitForAuthentication`. During `hold()`, create a dedicated observer `AbortController`, race its promise against `session.stop` and `jobAbort`, abort it in `finally`, and invoke `finalCheck(input)` only for authentication or manual stop:

```js
const observer = new AbortController();
const authenticated = Promise.resolve(
  waitForAuthentication(input.page, observer.signal),
).then(() => "authenticated", () => "observer_ended");
try {
  const outcome = await Promise.race([
    session.stop.promise.then(() => "stop"),
    jobAbort.promise.then(() => "abort"),
    authenticated,
  ]);
  if (outcome === "abort")
    throw jobAbort.signal.reason instanceof Error
      ? jobAbort.signal.reason
      : new Error("visible browser session aborted");
  if (outcome === "observer_ended") {
    const manual = await Promise.race([
      session.stop.promise.then(() => "stop"),
      jobAbort.promise.then(() => "abort"),
    ]);
    if (manual === "abort")
      throw jobAbort.signal.reason instanceof Error
        ? jobAbort.signal.reason
        : new Error("visible browser session aborted");
  }
  return finalCheck(input);
} finally {
  observer.abort();
}
```

Use a small local helper for the second wait so a transient observer failure does not recursively create observers or duplicate the final check.

- [ ] **Step 7: Wire the real waiter through process composition**

In `browser-helper/main.mjs`:

```js
import { runGoogleLogin, waitForGoogleAuthentication } from "./google-login.mjs";

const sessions = createVisibleSessionCoordinator(config, {
  novnc,
  scheduler: { enqueue: (job) => scheduler.enqueue(job) },
  waitForAuthentication: dependencies.waitForAuthentication || waitForGoogleAuthentication,
});
```

Add a composition test that captures `createSessions` options and asserts the waiter is a function.

- [ ] **Step 8: Run focused browser-helper tests and commit**

```powershell
pnpm exec vitest run tests/unit/browser-helper/google-login.test.ts tests/unit/browser-helper/server.test.ts tests/unit/browser-helper/main.test.ts
git add browser-helper/google-login.mjs browser-helper/main.mjs browser-helper/server.mjs tests/unit/browser-helper/google-login.test.ts tests/unit/browser-helper/main.test.ts tests/unit/browser-helper/server.test.ts
git commit -m "feat: finish visible browser sessions after login"
```

Expected: focused tests pass and the commit contains only visible-session completion behavior.

### Task 3: Integrate Account Import Into The Workspace

**Files:**
- Modify: `src/admin-ui/app.tsx`
- Modify: `src/admin-ui/i18n.ts`
- Modify: `src/admin-ui/sections/ImportPanel.tsx`
- Modify: `src/admin-ui/sections/OverviewSection.tsx`
- Modify: `src/admin-ui/sections/Workspace.tsx`
- Modify: `src/admin-ui/styles/layout.css`
- Create: `tests/unit/admin-ui/workspace-layout.contract.test.ts`

- [ ] **Step 1: Write a failing source contract for workspace ownership**

Create a focused contract test that reads the three component sources and asserts ownership without rendering a browser:

```ts
const app = await readFile("src/admin-ui/app.tsx", "utf8");
const overview = await readFile("src/admin-ui/sections/OverviewSection.tsx", "utf8");
const workspace = await readFile("src/admin-ui/sections/Workspace.tsx", "utf8");
assert.doesNotMatch(app, /<ImportPanel\s*\/>/);
assert.doesNotMatch(overview, /importExpanded|Import accounts/);
assert.match(workspace, /<ImportPanel\s*\/>/);
assert.match(workspace, /aria-controls="import-panel"/);
```

- [ ] **Step 2: Run the contract and verify RED**

```powershell
pnpm exec vitest run tests/unit/admin-ui/workspace-layout.contract.test.ts
```

Expected: assertions fail because `App` and `OverviewSection` still own import UI.

- [ ] **Step 3: Move the disclosure into `Workspace`**

Remove the top-level `ImportPanel` from `App` and the import toggle from `OverviewSection`. Import `ImportPanel` and `importExpanded` in `Workspace`, add the button beside refresh, and render the disclosure before filters:

```tsx
<button
  type="button"
  aria-expanded={importExpanded.value}
  aria-controls="import-panel"
  onClick={() => {
    importExpanded.value = !importExpanded.value;
  }}
>
  <Icon name="plus" />
  {tr("Add accounts")}
</button>
<ImportPanel />
```

- [ ] **Step 4: Make import an unframed workspace band**

Change the `ImportPanel` root from a nested `.panel.disclosure` section to:

```tsx
<section id="import-panel" class="workspace-import" hidden={!importExpanded.value}>
```

Use a compact internal heading and retain the existing form, submit, reset, state, and validation logic. Add `Add accounts` and `Close add accounts` translations. Style `.workspace-import` with a bottom border, `var(--surface-subtle)` background, and existing spacing tokens.

- [ ] **Step 5: Run import and layout tests and commit**

```powershell
pnpm exec vitest run tests/unit/admin-ui/workspace-layout.contract.test.ts tests/unit/admin-ui/actions-import.test.ts tests/unit/admin-ui/api-import.test.ts
git add src/admin-ui/app.tsx src/admin-ui/i18n.ts src/admin-ui/sections/ImportPanel.tsx src/admin-ui/sections/OverviewSection.tsx src/admin-ui/sections/Workspace.tsx src/admin-ui/styles/layout.css tests/unit/admin-ui/workspace-layout.contract.test.ts
git commit -m "feat: integrate account import into workspace"
```

Expected: layout contract and existing import behavior tests pass.

### Task 4: Keep Row Action Options Inside The Table Flow

**Files:**
- Modify: `src/admin-ui/styles/components.css`
- Modify: `src/admin-ui/styles/responsive.css`
- Modify: `tests/unit/admin-ui/workspace-layout.contract.test.ts`

- [ ] **Step 1: Add a failing CSS contract**

Extend the layout contract to assert that row menus use normal flow while bulk menus retain floating positioning:

```ts
assert.match(css, /\.account-actions \.action-menu-items\s*\{[^}]*position:\s*static/s);
assert.match(css, /\.bulk-menu \.action-menu-items\s*\{[^}]*position:\s*absolute/s);
```

- [ ] **Step 2: Run the contract and verify RED**

```powershell
pnpm exec vitest run tests/unit/admin-ui/workspace-layout.contract.test.ts
```

Expected: the row-menu assertion fails because all menus are absolute.

- [ ] **Step 3: Add the minimum row-specific CSS override**

Keep the shared floating menu rule for bulk actions, then override row menus:

```css
.account-actions {
  flex-wrap: wrap;
}
.account-actions .action-menu-items {
  position: static;
  width: min(210px, calc(100vw - 48px));
  margin-top: 5px;
}
.bulk-menu .action-menu-items {
  position: absolute;
  top: calc(100% + 5px);
  right: 0;
}
```

On small screens, make the row `details` and its menu full width so labels cannot overflow.

- [ ] **Step 4: Run the layout contract and commit**

```powershell
pnpm exec vitest run tests/unit/admin-ui/workspace-layout.contract.test.ts
git add src/admin-ui/styles/components.css src/admin-ui/styles/responsive.css tests/unit/admin-ui/workspace-layout.contract.test.ts
git commit -m "fix: keep account action menus visible"
```

Expected: the source/CSS contract passes.

### Task 5: Full Verification And Docker Deployment

**Files:**
- Verify: all modified files
- Create locally and keep ignored: `tmp/admin-workspace-desktop.png`
- Create locally and keep ignored: `tmp/admin-workspace-mobile.png`

- [ ] **Step 1: Run all static and automated checks**

```powershell
pnpm check:static
pnpm typecheck
pnpm typecheck:tests
pnpm check:test-types
pnpm unit
pnpm build
pnpm smoke
```

Expected: every command exits 0; the unit summary reports no failed tests.

- [ ] **Step 2: Rebuild and restart both containers**

```powershell
docker compose build web2gem browser-helper
docker compose up -d --no-build
docker compose ps
```

Expected: `web2gem` and `browser-helper` are both `healthy`.

- [ ] **Step 3: Verify the visible-session runtime flow**

Use the admin API with `ADMIN_KEY` read locally from `.env` without printing it. Open the configured account's browser session, complete no user interaction, and verify the observer does not falsely finish on the login page. For an already authenticated profile, wait for the account status to become `ready`; confirm no Chromium process for that profile remains afterward. Stop the session through the API if the profile requires manual interaction.

- [ ] **Step 4: Capture isolated UI screenshots**

Launch Playwright Core inside the `browser-helper` container with a temporary profile. Authenticate the admin UI using the locally read `ADMIN_KEY`, capture desktop `1440x1000` and mobile `390x844` screenshots, and copy them to ignored `tmp/` files. Do not attach to or control the user's Chrome/Edge session.

Verify visually and by DOM measurements that:

- the `Add accounts` button is in the workspace header;
- the form is collapsed initially and expands above filters;
- no panel is nested inside the workspace panel;
- opening `More` increases the row/card height and every action button is within the table/card bounds;
- text does not overlap at either viewport.

- [ ] **Step 5: Re-run health and log checks**

```powershell
curl.exe -fsS http://127.0.0.1:18080/
docker compose ps
docker compose logs --tail=150 web2gem browser-helper
git status --short --branch
```

Expected: API status is `ok`, both containers are healthy, logs contain no startup failures or secrets, and only intentional files remain changed.
