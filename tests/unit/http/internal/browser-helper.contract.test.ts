import { describe, test } from "vitest";
import { handleApplicationRequest } from "../../../../src/app";
import type {
	BrowserAccountStore,
	BrowserNotificationState,
	BrowserStatusUpdate,
	EncryptedBrowserCredentials,
} from "../../../../src/browser/types";
import {
	createRuntimeConfig,
	getConfig,
	type AppEnv,
} from "../../../../src/config";
import { handleBrowserHelperRequest } from "../../../../src/http/internal/browser-helper";
import { assert } from "../../assertions.js";

const TOKEN = "browser-helper-secret";

class FakeBrowserStore implements BrowserAccountStore {
	calls: string[] = [];
	statusUpdates: BrowserStatusUpdate[] = [];
	notificationUpdates: unknown[][] = [];
	notificationUpdated = true;
	failureCode: string | null = null;
	notificationState: BrowserNotificationState | null = "manual_action_required";
	credentials: EncryptedBrowserCredentials | null = {
		version: 1,
		ciphertext: "encrypted-credentials",
		nonce: "encrypted-nonce",
		emailHash: "email-hash",
	};
	autoLoginAttemptCount = 0;

	async listScheduled() {
		this.calls.push("listScheduled");
		return [
			{
				accountId: "account-a",
				label: "Primary",
				status: {
					credentialsConfigured: true,
					state: "ready" as const,
					lastCheckAtMs: 10,
					lastCookieUpdateAtMs: 11,
					lastAutoLoginAtMs: 12,
					failureCode: this.failureCode,
					cookieHeader: "must-not-leak",
				},
				authFailureCount: 0,
				autoLoginAttemptDate: "2026-08-01",
				autoLoginAttemptCount: 1,
				notificationState: this.notificationState,
			},
		];
	}
	async getStatus() {
		this.calls.push("getStatus");
		return null;
	}
	async putCredentials() {
		throw new Error("unexpected putCredentials");
	}
	async clearCredentials() {
		throw new Error("unexpected clearCredentials");
	}
	async getEncryptedCredentials() {
		this.calls.push("getEncryptedCredentials");
		return this.credentials;
	}
	async tryAcquireLease(
		_accountId: string,
		owner: string,
		expiresAtMs: number,
		nowMs: number,
	) {
		this.calls.push(`lease:${owner}:${expiresAtMs - nowMs}`);
		return true;
	}
	async releaseLease(_accountId: string, owner: string) {
		this.calls.push(`release:${owner}`);
	}
	async writeStatus(_accountId: string, update: BrowserStatusUpdate) {
		this.calls.push("writeStatus");
		this.statusUpdates.push(update);
	}
	async patchNotificationState(
		accountId: string,
		expectedState: string,
		notificationState: string,
		nowMs: number,
	) {
		this.notificationUpdates.push([
			accountId,
			expectedState,
			notificationState,
			nowMs,
		]);
		return this.notificationUpdated;
	}
	async recordAutoLoginAttempt(accountId: string, date: string, nowMs: number) {
		this.calls.push(`attempt:${accountId}:${date}`);
		assert.equal(typeof nowMs, "number");
		return ++this.autoLoginAttemptCount;
	}
}

function env(store: BrowserAccountStore = new FakeBrowserStore()): AppEnv {
	return {
		BROWSER_HELPER_INTERNAL_TOKEN: TOKEN,
		BROWSER_ACCOUNT_STORE: store,
		BROWSER_CANDIDATE_COOKIE_SERVICE: {
			async replace() {
				return {
					ok: true as const,
					changed: true,
					state: "ready" as const,
					lastCookieUpdateAtMs: 123,
				};
			},
		},
	};
}

function request(path: string, init: RequestInit = {}, activeEnv = env()) {
	const url = new URL(`https://worker.example${path}`);
	return handleBrowserHelperRequest(
		new Request(url, {
			...init,
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				...(init.headers || {}),
			},
		}),
		activeEnv,
		createRuntimeConfig(getConfig(activeEnv)),
		url,
	);
}

describe("private browser-helper HTTP contract", () => {
	test("rejects missing, wrong, and ADMIN_KEY bearer tokens before store access", async () => {
		for (const authorization of [
			undefined,
			"Bearer wrong",
			"Bearer admin-secret",
		]) {
			const store = new FakeBrowserStore();
			const headers = authorization ? { Authorization: authorization } : {};
			const url = new URL("https://worker.example/internal/browser/accounts");
			const response = await handleBrowserHelperRequest(
				new Request(url, { headers }),
				{ ...env(store), ADMIN_KEY: "admin-secret" },
				createRuntimeConfig(getConfig({ ADMIN_KEY: "admin-secret" })),
				url,
			);
			assert.equal(response.status, 401);
			assert.equal(store.calls.length, 0);
			assert.deepEqual(await response.json(), {
				error: {
					code: "invalid_browser_helper_token",
					message: "unauthorized",
				},
			});
		}
	});

	test("runs before public API authentication in the application", async () => {
		const response = await handleApplicationRequest(
			new Request("https://worker.example/internal/browser/accounts", {
				headers: { Authorization: `Bearer ${TOKEN}` },
			}),
			{ ...env(), API_KEYS: "unrelated-public-key" },
			{ waitUntil() {} },
		);
		assert.equal(response.status, 200);
	});

	test("authenticates before parsing unrelated runtime configuration", async () => {
		for (const authorization of [undefined, "Bearer wrong"]) {
			const headers = authorization ? { Authorization: authorization } : {};
			const response = await handleApplicationRequest(
				new Request("https://worker.example/internal/browser/accounts", {
					headers,
				}),
				{
					...env(),
					RETRY_ATTEMPTS: "not-a-number",
				},
				{ waitUntil() {} },
			);
			assert.equal(response.status, 401);
			const text = await response.text();
			assert.doesNotMatch(text, /RETRY_ATTEMPTS|not-a-number/i);
			assert.deepEqual(JSON.parse(text), {
				error: {
					code: "invalid_browser_helper_token",
					message: "unauthorized",
				},
			});
		}
	});

	test("lists only safe enabled-account schedule fields", async () => {
		const store = new FakeBrowserStore();
		store.failureCode = "SQL token=private-cookie";
		(store as unknown as { notificationState: string }).notificationState =
			"token=private-notification";
		const response = await request(
			"/internal/browser/accounts",
			{},
			env(store),
		);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.deepEqual(body, {
			accounts: [
				{
					id: "account-a",
					label: "Primary",
					status: {
						credentialsConfigured: true,
						state: "ready",
						lastCheckAtMs: 10,
						lastCookieUpdateAtMs: 11,
						lastAutoLoginAtMs: 12,
						failureCode: null,
					},
					authFailureCount: 0,
					autoLoginAttemptDate: "2026-08-01",
					autoLoginAttemptCount: 1,
					notificationState: null,
				},
			],
		});
		assert.doesNotMatch(
			JSON.stringify(body),
			/cookieHeader|cookieHash|ciphertext|nonce|emailHash|internalToken|private-notification/i,
		);
	});

	test("supports lease acquire and owner-scoped release with bounded inputs", async () => {
		const store = new FakeBrowserStore();
		const acquire = await request(
			"/internal/browser/accounts/account-a/lease",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ owner: "helper-1", ttlSeconds: 30 }),
			},
			env(store),
		);
		assert.equal(acquire.status, 200);
		assert.deepEqual(await acquire.json(), { acquired: true });
		const release = await request(
			"/internal/browser/accounts/account-a/lease",
			{
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ owner: "helper-1" }),
			},
			env(store),
		);
		assert.equal(release.status, 200);
		assert.deepEqual(await release.json(), { released: true });
		assert.deepEqual(store.calls, ["lease:helper-1:30000", "release:helper-1"]);

		for (const body of [
			{ owner: "x".repeat(129), ttlSeconds: 30 },
			{ owner: "ok", ttlSeconds: 29 },
			{ owner: "ok", ttlSeconds: 601 },
			{ owner: "ok", ttlSeconds: 30, extra: true },
		]) {
			const invalid = await request(
				"/internal/browser/accounts/account-a/lease",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
				env(store),
			);
			assert.equal(invalid.status, 400);
		}
	});

	test("atomically records a strictly dated automatic-login attempt", async () => {
		const store = new FakeBrowserStore();
		const response = await request(
			"/internal/browser/accounts/account-a/auto-login-attempt",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ date: "2026-08-01" }),
			},
			env(store),
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { count: 1 });
		assert.deepEqual(store.calls, ["attempt:account-a:2026-08-01"]);

		for (const body of [
			{ date: "2026-8-1" },
			{ date: "2026-02-30" },
			{ date: "2026-08-01", extra: true },
		]) {
			const invalid = await request(
				"/internal/browser/accounts/account-a/auto-login-attempt",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
				env(store),
			);
			assert.equal(invalid.status, 400);
		}
	});

	test("returns encrypted credential fields without decrypting them", async () => {
		const store = new FakeBrowserStore();
		store.credentials = {
			version: 1,
			ciphertext: "encrypted-credentials",
			nonce: "encrypted-nonce",
			emailHash: "email-hash",
			plaintextPassword: "must-not-leak",
		} as EncryptedBrowserCredentials;
		const response = await request(
			"/internal/browser/accounts/account-a/credentials",
			{},
			env(store),
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			version: 1,
			ciphertext: "encrypted-credentials",
			nonce: "encrypted-nonce",
			emailHash: "email-hash",
		});
	});

	test("rejects OPTIONS on private routes through internal authentication", async () => {
		const response = await handleApplicationRequest(
			new Request("https://worker.example/internal/browser/accounts", {
				method: "OPTIONS",
			}),
			env(),
			{ waitUntil() {} },
		);
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), {
			error: {
				code: "invalid_browser_helper_token",
				message: "unauthorized",
			},
		});
	});

	test("strictly validates state updates and bounds failure codes", async () => {
		const store = new FakeBrowserStore();
		const validBody = {
			state: "error",
			lastCheckAtMs: 10,
			lastCookieUpdateAtMs: 11,
			lastAutoLoginAtMs: null,
			authFailureCount: 2,
			notificationState: "error",
			failureCode: "login_failed_2",
		};
		const response = await request(
			"/internal/browser/accounts/account-a/state",
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(validBody),
			},
			env(store),
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { updated: true });
		assert.equal(store.statusUpdates[0]?.failureCode, "login_failed_2");
		assert.equal(typeof store.statusUpdates[0]?.nowMs, "number");

		for (const body of [
			{ ...validBody, failureCode: "UPPERCASE" },
			{ ...validBody, failureCode: "x".repeat(65) },
			{ ...validBody, notificationState: "sent" },
			{ ...validBody, notificationState: "token=private" },
			{ ...validBody, extra: "secret" },
		]) {
			const invalid = await request(
				"/internal/browser/accounts/account-a/state",
				{
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
				env(store),
			);
			assert.equal(invalid.status, 400);
		}
	});

	test("CAS-patches notification state without rewriting full status", async () => {
		const store = new FakeBrowserStore();
		store.notificationUpdated = false;
		const response = await request(
			"/internal/browser/accounts/account-a/state",
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedState: "manual_action_required",
					notificationState: "manual_action_required",
				}),
			},
			env(store),
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { updated: false });
		assert.equal(store.statusUpdates.length, 0);
		assert.equal(store.notificationUpdates.length, 1);
		assert.deepEqual(store.notificationUpdates[0]?.slice(0, 3), [
			"account-a",
			"manual_action_required",
			"manual_action_required",
		]);
		assert.equal(typeof store.notificationUpdates[0]?.[3], "number");

		for (const body of [
			{ expectedState: "unknown", notificationState: "error" },
			{ expectedState: "error", notificationState: "unknown" },
			{ expectedState: "error", notificationState: "error", extra: true },
		]) {
			const invalid = await request(
				"/internal/browser/accounts/account-a/state",
				{
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
				env(store),
			);
			assert.equal(invalid.status, 400);
		}
	});

	test("delegates candidate cookies and returns exactly the safe result", async () => {
		let received: unknown;
		const activeEnv = env();
		activeEnv.BROWSER_CANDIDATE_COOKIE_SERVICE = {
			async replace(input) {
				received = input;
				return {
					ok: true,
					changed: false,
					state: "ready",
					lastCookieUpdateAtMs: 456,
				};
			},
		};
		const response = await request(
			"/internal/browser/accounts/account-a/candidate-cookie",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					psid: "private-psid",
					psidts: "private-psidts",
					observedEmail: "owner@example.com",
				}),
			},
			activeEnv,
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			changed: false,
			state: "ready",
			lastCookieUpdateAtMs: 456,
		});
		assert.equal((received as { accountId?: unknown }).accountId, "account-a");
		assert.equal(typeof (received as { nowMs?: unknown }).nowMs, "number");
	});

	test("enforces bounded JSON and rejects malformed and unknown fields before store access", async () => {
		const store = new FakeBrowserStore();
		for (const body of [
			"{",
			JSON.stringify({ owner: "ok", extra: "x".repeat(70_000) }),
		]) {
			const response = await request(
				"/internal/browser/accounts/account-a/lease",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				},
				env(store),
			);
			assert.equal(response.status, body === "{" ? 400 : 413);
		}
		assert.equal(store.calls.length, 0);
	});

	test("supports only the six declared routes and redacts internal failures", async () => {
		for (const [path, method] of [
			["/internal/browser/accounts/stats", "GET"],
			["/internal/browser/accounts/account-a/credentials", "POST"],
			["/internal/browser/accounts/account-a/candidate-cookie", "DELETE"],
		] as const) {
			const response = await request(path, { method });
			assert.equal(response.status, 404);
		}

		const store = new FakeBrowserStore();
		store.listScheduled = async () => {
			throw new Error(
				"SQL failed cookie=private credential=private token=private",
			);
		};
		const response = await request(
			"/internal/browser/accounts",
			{},
			env(store),
		);
		assert.equal(response.status, 500);
		const text = await response.text();
		assert.doesNotMatch(text, /SQL|cookie|credential|token|private/i);
		assert.deepEqual(JSON.parse(text), {
			error: {
				code: "browser_helper_request_failed",
				message: "browser helper request failed",
			},
		});
	});
});
