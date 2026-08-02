import { afterEach, describe, test } from "vitest";
import {
	checkBrowserForAccount,
	clearBrowserLogin,
	configureBrowserLogin,
	deleteBrowserProfile,
	loadAccounts,
	openBrowserForAccount,
} from "../../../src/admin-ui/actions";
import {
	resolveConfirmation,
	updateAdminKey,
} from "../../../src/admin-ui/session";
import {
	confirmationDraft,
	connectionVerified,
	accounts,
	loading,
	rowBusy,
	toastItems,
} from "../../../src/admin-ui/state";
import { deferred } from "../_support/deferred.js";
import { assert } from "../assertions.js";
import { withAdminEnvironment } from "./_support/environment.js";
import { uiAccount, uiAccountOverview } from "./_support/fixtures.js";
import {
	resetAccountViewState,
	resetAdminSessionState,
} from "./_support/state.js";

type Popup = {
	closed: boolean;
	opener: unknown;
	document: { title: string; body: { textContent: string | null } };
	location: { href: string };
	close(): void;
};

function popup(): Popup {
	return {
		closed: false,
		opener: { unsafe: true },
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
					if (args[2] === "noopener") return null;
					return opened;
				},
				confirm: () => false,
			},
		);
		assert.deepEqual(calls, [["about:blank", "_blank"]]);
		assert.equal(opened.opener, null);
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

	test("rejects every noVNC query string and fragment", async () => {
		const opened = [popup(), popup(), popup()];
		const urls = [
			"https://admin.example:6080/vnc.html?token=secret",
			"https://admin.example:6080/vnc.html?view=fit",
			"https://admin.example:6080/vnc.html#connected",
			"http://admin.example:6080/vnc.html",
		];
		opened.push(popup());
		let index = 0;
		await withAdminEnvironment(
			async () => Response.json({ url: urls[index++] }),
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				for (let attempt = 0; attempt < urls.length; attempt++)
					await openBrowserForAccount(uiAccount());
			},
			{
				location: { hostname: "admin.example" },
				open: () => opened[index],
				confirm: () => false,
			},
		);
		assert.equal(
			opened.every((item) => item.closed),
			true,
		);
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

	test("securely reuses the controlled popup through conflict stop and retry", async () => {
		const controlledPopup = popup();
		let openCalls = 0;
		const requests: string[] = [];
		const stopStarted = deferred();
		const stopResponse = deferred<Response>();
		let confirmations = 0;
		try {
			await withAdminEnvironment(
				async (path: RequestInfo | URL) => {
					requests.push(String(path));
					if (requests.length === 1)
						return Response.json(
							{ error: { code: "visible_session_conflict", message: "busy" } },
							{ status: 409 },
						);
					if (String(path) === "/admin/browser/stop") {
						stopStarted.resolve();
						return stopResponse.promise;
					}
					return Response.json({ url: "http://localhost:6080/vnc.html" });
				},
				async () => {
					updateAdminKey("admin-secret");
					connectionVerified.value = true;
					const opening = openBrowserForAccount(uiAccount({ label: "Alpha" }));
					await stopStarted.promise;
					assert.equal(openCalls, 1);
					assert.equal(controlledPopup.opener, null);
					assert.match(
						controlledPopup.document.body.textContent || "",
						/waiting/i,
					);
					assert.deepEqual(rowBusy.value, { "account-a": "browser_open" });
					await checkBrowserForAccount(uiAccount({ id: "account-a" }));
					assert.equal(requests.length, 2);
					assert.deepEqual(rowBusy.value, { "account-a": "browser_open" });
					stopResponse.resolve(Response.json({ stopped: true }));
					await opening;
				},
				{
					location: { hostname: "admin.example" },
					open: () => {
						openCalls++;
						return controlledPopup;
					},
					confirm: () => {
						confirmations++;
						return true;
					},
				},
			);
		} finally {
			stopStarted.resolve();
			stopResponse.resolve(Response.json({ stopped: true }));
		}
		assert.equal(confirmations, 1);
		assert.equal(controlledPopup.closed, false);
		assert.equal(
			controlledPopup.location.href,
			"http://localhost:6080/vnc.html",
		);
		assert.deepEqual(requests, [
			"/admin/accounts/account-a/browser/open",
			"/admin/browser/stop",
			"/admin/accounts/account-a/browser/open",
		]);
	});

	test("closes the controlled waiting tab when stopping the active session fails", async () => {
		const controlledPopup = popup();
		let requests = 0;
		await withAdminEnvironment(
			async () => {
				requests++;
				return requests === 1
					? Response.json(
							{
								error: {
									code: "visible_session_conflict",
									message: "busy",
								},
							},
							{ status: 409 },
						)
					: Response.json(
							{ error: { code: "stop_failed", message: "stop failed" } },
							{ status: 503 },
						);
			},
			async () => {
				updateAdminKey("admin-secret");
				connectionVerified.value = true;
				await openBrowserForAccount(uiAccount());
			},
			{
				location: { hostname: "admin.example" },
				open: () => controlledPopup,
				confirm: () => true,
			},
		);
		assert.equal(controlledPopup.closed, true);
		assert.equal(requests, 2);
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
			async (path: RequestInfo | URL) =>
				String(path).endsWith("/browser/check")
					? response.promise
					: Response.json(uiAccountOverview()),
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
				for (let index = 0; index < 20 && loading.value; index += 1)
					await Promise.resolve();
				assert.equal(loading.value, false);
			},
		);
	});

	test("an authoritative reload after a browser mutation fences an older account load", async () => {
		const oldLoadStarted = deferred();
		const oldLoadResponse = deferred<Response>();
		const requests: string[] = [];
		try {
			await withAdminEnvironment(
				async (path: RequestInfo | URL) => {
					requests.push(String(path));
					if (requests.length === 1) {
						oldLoadStarted.resolve();
						return oldLoadResponse.promise;
					}
					if (String(path).endsWith("/browser/check"))
						return Response.json({
							credentialsConfigured: false,
							status: {
								state: "ready",
								lastCheckAtMs: 20,
								lastCookieUpdateAtMs: null,
								lastAutoLoginAtMs: null,
								failureCode: null,
							},
						});
					return Response.json(
						uiAccountOverview([
							uiAccount({ label: "authoritative", updated_at_ms: 20 }),
						]),
					);
				},
				async () => {
					updateAdminKey("admin-secret");
					connectionVerified.value = true;
					accounts.value = [uiAccount({ label: "initial" })];
					const stale = loadAccounts();
					await oldLoadStarted.promise;
					await checkBrowserForAccount(uiAccount());
					oldLoadResponse.resolve(
						Response.json(
							uiAccountOverview([
								uiAccount({ label: "stale", updated_at_ms: 10 }),
							]),
						),
					);
					await stale;
					for (
						let index = 0;
						index < 20 && accounts.value[0]?.label !== "authoritative";
						index += 1
					)
						await Promise.resolve();
					assert.deepEqual(requests, [
						"/admin/accounts?limit=200",
						"/admin/accounts/account-a/browser/check",
						"/admin/accounts?limit=200",
					]);
					assert.equal(accounts.value[0]?.label, "authoritative");
					assert.equal(loading.value, false);
				},
			);
		} finally {
			oldLoadStarted.resolve();
			oldLoadResponse.resolve(Response.json(uiAccountOverview()));
		}
	});

	test("credential save resolves while its authoritative reload is still pending", async () => {
		const reloadStarted = deferred();
		const reloadResponse = deferred<Response>();
		const saveFinished = deferred<boolean>();
		try {
			await withAdminEnvironment(
				async (path: RequestInfo | URL) => {
					if (String(path).endsWith("/browser/credentials"))
						return Response.json({
							credentialsConfigured: true,
							status: {
								state: "ready",
								lastCheckAtMs: 20,
								lastCookieUpdateAtMs: null,
								lastAutoLoginAtMs: null,
								failureCode: null,
							},
						});
					reloadStarted.resolve();
					return reloadResponse.promise;
				},
				async () => {
					updateAdminKey("admin-secret");
					connectionVerified.value = true;
					accounts.value = [uiAccount()];
					const saving = configureBrowserLogin("account-a", {
						email: "owner@example.com",
						password: "private-password",
						totpSecret: "JBSWY3DPEHPK3PXP",
					}).then((saved) => {
						saveFinished.resolve(saved);
						return saved;
					});
					await reloadStarted.promise;
					for (let index = 0; index < 20 && !saveFinished.settled; index += 1)
						await Promise.resolve();
					assert.equal(saveFinished.settled, true);
					assert.equal(await saving, true);
					assert.deepEqual(rowBusy.value, {});
					assert.equal(loading.value, true);
					reloadResponse.resolve(Response.json(uiAccountOverview()));
					for (let index = 0; index < 20 && loading.value; index += 1)
						await Promise.resolve();
					assert.equal(loading.value, false);
				},
			);
		} finally {
			reloadStarted.resolve();
			reloadResponse.resolve(Response.json(uiAccountOverview()));
		}
	});

	test("uses separate account-labelled confirmations for credentials and profile", async () => {
		const requests: string[] = [];
		await withAdminEnvironment(
			async (path: RequestInfo | URL) => {
				requests.push(String(path));
				if (String(path) === "/admin/accounts?limit=200")
					return Response.json(uiAccountOverview());
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
				for (let index = 0; index < 20 && loading.value; index += 1)
					await Promise.resolve();
				assert.equal(loading.value, false);

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
			"/admin/accounts?limit=200",
			"/admin/accounts/account-a/browser/profile",
		]);
	});
});
