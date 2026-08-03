# Account Workspace And Visible Browser Completion Design

## Scope

This change addresses three related operator-facing problems:

1. A visible browser session remains in `checking` after the user has completed Google login.
2. Account import is separated from the account workspace even though both operate on the same account set.
3. Row action menus are clipped by the horizontally scrollable account table.

The change does not alter credential encryption, lease ownership, scheduled headless checks, account routing, or proxy configuration.

## Visible Browser Completion

The visible session coordinator will observe the open page while the session is active. It will use an injected, read-only Gemini authentication predicate rather than duplicating Google selectors in the coordinator.

When the predicate confirms that the page is an authenticated Gemini page, the coordinator will end the hold and run the existing final login check. That existing check reads and validates the Gemini cookies, submits the candidate CK through web2gem, updates the browser account state, and closes Chromium and noVNC during normal job cleanup.

The observer will:

- poll at a short fixed interval without submitting forms or entering credentials;
- treat transient page inspection errors as "not authenticated yet";
- stop promptly when the user stops the session, the job is aborted, or the maintenance lease is lost;
- preserve the current idle timeout as a fallback;
- never submit CK or state after lease loss.

Successful authentication therefore changes the account from `checking` to `ready` without requiring the operator to wait for the 30-minute idle timeout or call the stop endpoint.

## Account Workspace Integration

The overview remains a read-only summary and no longer owns the import toggle.

The account workspace header will contain:

- the existing refresh command;
- a new `Add accounts` command with a plus icon;
- `aria-expanded` and `aria-controls` attributes bound to the existing import disclosure state.

The existing single-account and batch-import form will move inside the workspace, immediately below its header and above filters. It remains collapsed by default. The form will be an unframed workspace band rather than a panel nested inside another panel. Existing import state, validation, API calls, reset behavior, and busy handling remain unchanged.

## Row Actions

The current absolute action menu is clipped because it is inside `.table-wrap`, which must retain horizontal overflow for wide account tables.

Row actions will remain a native `details` disclosure, but the option list will expand in normal layout flow inside the action cell. Expanding it increases the row height, so every option stays inside the scrollable table bounds and remains reachable by mouse and keyboard. Bulk actions may retain their existing floating menu because they are outside the table scroller.

On the mobile account-card layout, the same disclosure continues to render in flow. No additional menu dependency or custom positioning system will be added.

## Error Handling

- Authentication detection does not convert an intermediate Google page into a failure.
- The existing final cookie validation remains authoritative.
- Manual challenges continue to stay visible for the operator until resolved, stopped, aborted, or timed out.
- Lease loss continues to abort the job, close Chromium, suppress CK/state writes, and release only the current owner's lease.
- Import and row action errors continue through the existing toast and confirmation paths.

## Tests And Verification

Automated coverage will include:

- visible sessions finish automatically when authentication becomes observable;
- visible-session polling stops on manual stop and abort;
- transient predicate errors do not end the session;
- the account import disclosure is owned by the workspace, not the overview;
- the row menu uses in-flow table styling and is not absolutely positioned;
- existing import, action, lease-loss, and browser-helper tests continue to pass.

Runtime verification will rebuild both affected Docker images, confirm both services are healthy, open a visible session through the API, and verify that authenticated completion closes the helper Chromium and updates the sanitized account browser state. UI verification will use an isolated Playwright test process and screenshots, not the user's browser session.
