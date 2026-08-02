import { afterEach, describe, test } from "vitest";
import { readFileSync } from "node:fs";
import {
	checkBrowserForAccount,
	clearBrowserLogin,
	deleteBrowserProfile,
	openBrowserForAccount,
} from "../../../src/admin-ui/actions";
import {
	resolveConfirmation,
	updateAdminKey,
} from "../../../src/admin-ui/session";
import {
	confirmationDraft,
	connectionVerified,
	rowBusy,
	toastItems,
} from "../../../src/admin-ui/state";
import { deferred } from "../_support/deferred.js";
import { assert } from "../assertions.js";
import { withAdminEnvironment } from "./_support/environment.js";
import { uiAccount } from "./_support/fixtures.js";
import {
	resetAccountViewState,
	resetAdminSessionState,
} from "./_support/state.js";

type Popup = {
	closed: boolean;
	document: { title: string; body: { textContent: string | null } };
	location: { href: string };
	close(): void;
};

function popup(): Popup {
	return {
		closed: false,
		document: { title: "", body: { textContent: null } },
		location: { href: "about:blank" },
		close() {
			this.closed = true;
		},
	};
}

describe("admin UI browser actions", () => {
	afterEach(() => {
		resetAccountViewState();
		resetAdminSessionState();
	});

	test("opens a waiting tab synchronously and navigates only to a safe noVNC URL", async () => {
		const opened = popup();
		const calls: unknown[][] = [];
		await withAdminEnvironment(
			async () => Response.json({ url: "http://127.0.0.1:6080/vnc.html" }),
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				let requestStarted = false;
				const action = openBrowserForAccount(uiAccount());
				requestStarted = true;
				assert.equal(calls.length, 1);
				assert.equal(requestStarted, true);
				await action;
			},
			{
				location: { hostname: "admin.example" },
				open: (...args: unknown[]) => {
					calls.push(args);
					return opened;
				},
				confirm: () => false,
			},
		);
		assert.deepEqual(calls, [["about:blank", "_blank", "noopener"]]);
		assert.match(opened.document.body.textContent || "", /waiting/i);
		assert.equal(opened.location.href, "http://127.0.0.1:6080/vnc.html");
		assert.equal(opened.closed, false);
	});

	test("closes an unsafe URL tab and reports a local error", async () => {
		const opened = popup();
		await withAdminEnvironment(
			async () =>
				Response.json({
					url: "https://evil.example/vnc.html?password=secret",
				}),
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				await openBrowserForAccount(uiAccount());
			},
			{
				location: { hostname: "admin.example" },
				open: () => opened,
				confirm: () => false,
			},
		);
		assert.equal(opened.closed, true);
		assert.match(toastItems.value.at(-1)?.message || "", /browser/i);
	});

	test("accepts a same-host noVNC URL", async () => {
		const opened = popup();
		await withAdminEnvironment(
			async () => Response.json({ url: "https://admin.example:6080/vnc.html" }),
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				await openBrowserForAccount(uiAccount());
			},
			{
				location: { hostname: "admin.example" },
				open: () => opened,
				confirm: () => false,
			},
		);
		assert.equal(opened.location.href, "https://admin.example:6080/vnc.html");
		assert.equal(opened.closed, false);
	});

	test("stops a conflicting visible session only after confirmation, then retries", async () => {
		const firstPopup = popup();
		const secondPopup = popup();
		const popups = [firstPopup, secondPopup];
		const requests: string[] = [];
		let confirmations = 0;
		await withAdminEnvironment(
			async (path: RequestInfo | URL) => {
				requests.push(String(path));
				if (requests.length === 1)
					return Response.json(
						{ error: { code: "visible_session_conflict", message: "busy" } },
						{ status: 409 },
					);
				if (String(path) === "/admin/browser/stop")
					return Response.json({ stopped: true });
				return Response.json({ url: "http://localhost:6080/vnc.html" });
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				await openBrowserForAccount(uiAccount({ label: "Alpha" }));
			},
			{
				location: { hostname: "admin.example" },
				open: () => popups.shift(),
				confirm: () => {
					confirmations++;
					return true;
				},
			},
		);
		assert.equal(confirmations, 1);
		assert.equal(firstPopup.closed, true);
		assert.equal(secondPopup.location.href, "http://localhost:6080/vnc.html");
		assert.deepEqual(requests, [
			"/admin/accounts/account-a/browser/open",
			"/admin/browser/stop",
			"/admin/accounts/account-a/browser/open",
		]);
	});

	test("does not stop or retry a conflict when confirmation is declined", async () => {
		const opened = popup();
		const requests: string[] = [];
		await withAdminEnvironment(
			async (path: RequestInfo | URL) => {
				requests.push(String(path));
				return Response.json(
					{ error: { code: "visible_session_conflict", message: "busy" } },
					{ status: 409 },
				);
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				await openBrowserForAccount(uiAccount());
			},
			{
				location: { hostname: "admin.example" },
				open: () => opened,
				confirm: () => false,
			},
		);
		assert.equal(opened.closed, true);
		assert.deepEqual(requests, ["/admin/accounts/account-a/browser/open"]);
	});

	test("keeps browser busy state isolated to the active account", async () => {
		const response = deferred<Response>();
		await withAdminEnvironment(
			async () => response.promise,
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				const checking = checkBrowserForAccount(uiAccount({ id: "account-a" }));
				await Promise.resolve();
				assert.deepEqual(rowBusy.value, { "account-a": "browser_check" });
				assert.equal(Object.hasOwn(rowBusy.value, "account-b"), false);
				response.resolve(
					Response.json({
						credentialsConfigured: false,
						status: {
							state: "ready",
							lastCheckAtMs: 10,
							lastCookieUpdateAtMs: null,
							lastAutoLoginAtMs: null,
							failureCode: null,
						},
					}),
				);
				await checking;
				assert.deepEqual(rowBusy.value, {});
			},
		);
	});

	test("uses separate account-labelled confirmations for credentials and profile", async () => {
		const requests: string[] = [];
		await withAdminEnvironment(
			async (path: RequestInfo | URL) => {
				requests.push(String(path));
				return String(path).endsWith("/profile")
					? Response.json({ deleted: true })
					: Response.json({
							credentialsConfigured: false,
							status: {
								state: "idle",
								lastCheckAtMs: null,
								lastCookieUpdateAtMs: null,
								lastAutoLoginAtMs: null,
								failureCode: null,
							},
						});
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				const account = uiAccount({
					label: "Alpha",
					browser: {
						...uiAccount().browser,
						credentialsConfigured: true,
					},
				});
				const clearing = clearBrowserLogin(account);
				assert.deepEqual(confirmationDraft.value, {
					action: "clear_browser_credentials",
					accountId: "account-a",
					accountLabel: "Alpha",
				});
				resolveConfirmation(true);
				await clearing;

				const deleting = deleteBrowserProfile(account);
				assert.deepEqual(confirmationDraft.value, {
					action: "delete_browser_profile",
					accountId: "account-a",
					accountLabel: "Alpha",
				});
				resolveConfirmation(true);
				await deleting;
			},
		);
		assert.deepEqual(requests, [
			"/admin/accounts/account-a/browser/credentials",
			"/admin/accounts/account-a/browser/profile",
		]);
	});

	test("keeps credentials in modal-local state and preserves accessible field contracts", () => {
		const source = readFileSync(
			new URL(
				"../../../src/admin-ui/components/BrowserCredentialsModal.tsx",
				import.meta.url,
			),
			"utf8",
		);
		assert.match(source, /useState\(""\)/);
		assert.match(source, /finally\s*{[\s\S]*?clear\(\)/);
		assert.match(source, /type="email"[\s\S]*?autoComplete="username"/);
		assert.match(
			source,
			/type="password"[\s\S]*?autoComplete="current-password"/,
		);
		assert.match(source, /autoComplete="one-time-code"/);
		assert.match(source, /Authenticator seed help/);
		assert.doesNotMatch(source, /signal\s*</);
	});
});
