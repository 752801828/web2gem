import { describe, test } from "vitest";
import { handleApplicationRequest } from "../../../../src/app";
import type {
	BrowserAccountStore,
	BrowserCredentials,
	BrowserStatusUpdate,
	EncryptedBrowserCredentials,
} from "../../../../src/browser/types";
import {
	createRuntimeConfig,
	getConfig,
	type AppEnv,
} from "../../../../src/config";
import { handleBrowserAccountAdminRequest } from "../../../../src/http/admin/browser-accounts";
import { assert } from "../../assertions.js";

const ADMIN_KEY = "admin-secret";
const ACCOUNT_ID = "account-a";
const ENCRYPTED: EncryptedBrowserCredentials = {
	version: 1,
	ciphertext: "ciphertext",
	nonce: "nonce",
	emailHash: "email-hash",
};

class FakeStore implements BrowserAccountStore {
	calls: string[] = [];
	encrypted: EncryptedBrowserCredentials | null = null;
	status = {
		credentialsConfigured: false,
		state: "idle" as const,
		lastCheckAtMs: null,
		lastCookieUpdateAtMs: null,
		lastAutoLoginAtMs: null,
		failureCode: null,
	};

	async listScheduled() {
		return [];
	}
	async getStatus() {
		this.calls.push("getStatus");
		return { ...this.status };
	}
	async putCredentials(_accountId: string, value: EncryptedBrowserCredentials) {
		this.calls.push("putCredentials");
		this.encrypted = value;
		this.status.credentialsConfigured = true;
	}
	async clearCredentials() {
		this.calls.push("clearCredentials");
		this.encrypted = null;
		this.status.credentialsConfigured = false;
	}
	async getEncryptedCredentials() {
		this.calls.push("getEncryptedCredentials");
		return this.encrypted;
	}
	async tryAcquireLease() {
		return false;
	}
	async releaseLease() {}
	async writeStatus(_accountId: string, _update: BrowserStatusUpdate) {}
	async patchNotificationState() {
		return false;
	}
	async recordAutoLoginAttempt() {
		return { reserved: false, count: 1 };
	}
}

function fixture() {
	const store = new FakeStore();
	const helperCalls: string[] = [];
	let encryptedInput: BrowserCredentials | null = null;
	let decrypted: BrowserCredentials | null = null;
	const env = {
		ADMIN_KEY,
		BROWSER_ACCOUNT_STORE: store,
		BROWSER_CREDENTIAL_CRYPTO: {
			async encrypt(_accountId: string, credentials: BrowserCredentials) {
				encryptedInput = { ...credentials };
				return ENCRYPTED;
			},
			async decrypt() {
				decrypted = {
					email: "old@example.com",
					password: "old-password",
					totpSecret: "JBSWY3DPEHPK3PXP",
				};
				return decrypted;
			},
		},
		BROWSER_HELPER_CLIENT: {
			async checkNow(accountId: string) {
				helperCalls.push(`check:${accountId}`);
			},
			async openVisible(accountId: string) {
				helperCalls.push(`open:${accountId}`);
				return { url: "http://127.0.0.1:6080/vnc.html" };
			},
			async stopVisible() {
				helperCalls.push("stop");
			},
			async deleteProfile(accountId: string) {
				helperCalls.push(`delete:${accountId}`);
			},
		},
	} satisfies AppEnv;
	return {
		env,
		store,
		helperCalls,
		getEncryptedInput: () => encryptedInput,
		getDecrypted: () => decrypted,
	};
}

function request(
	path: string,
	init: RequestInit = {},
	activeEnv: AppEnv = fixture().env,
) {
	const url = new URL(`https://worker.example${path}`);
	return handleBrowserAccountAdminRequest(
		new Request(url, {
			...init,
			headers: {
				Authorization: `Bearer ${ADMIN_KEY}`,
				...(init.headers || {}),
			},
		}),
		activeEnv,
		createRuntimeConfig(getConfig(activeEnv)),
		url,
	);
}

function json(method: string, value: unknown): RequestInit {
	return {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	};
}

describe("browser account admin contract", () => {
	test("authenticates before accessing credentials or helper controls", async () => {
		const active = fixture();
		const url = new URL(
			`https://worker.example/admin/accounts/${ACCOUNT_ID}/browser/check`,
		);
		const response = await handleBrowserAccountAdminRequest(
			new Request(url),
			active.env,
			createRuntimeConfig(getConfig(active.env)),
			url,
		);
		assert.equal(response.status, 401);
		assert.equal(active.store.calls.length, 0);
		assert.equal(active.helperCalls.length, 0);
	});

	test("authenticates malformed account paths before decoding the account id", async () => {
		const active = fixture();
		const response = await handleApplicationRequest(
			new Request("https://worker.example/admin/accounts/%/browser/check", {
				method: "POST",
			}),
			active.env,
			{ waitUntil() {} },
		);
		assert.equal(response.status, 401);
		assert.equal(active.helperCalls.length, 0);
	});

	test("requires a complete first credential configuration", async () => {
		const active = fixture();
		const path = `/admin/accounts/${ACCOUNT_ID}/browser/credentials`;
		const incomplete = await request(
			path,
			json("PUT", {
				email: "owner@example.com",
				password: "",
				totpSecret: "JBSWY3DPEHPK3PXP",
			}),
			active.env,
		);
		assert.equal(incomplete.status, 400);
		assert.equal(active.store.encrypted, null);

		const configured = await request(
			path,
			json("PUT", {
				email: "Owner@Example.com",
				password: "new-password",
				totpSecret: "JBSW Y3DP EHPK 3PXP",
			}),
			active.env,
		);
		assert.equal(configured.status, 200);
		assert.deepEqual(active.getEncryptedInput(), {
			email: "owner@example.com",
			password: "new-password",
			totpSecret: "JBSWY3DPEHPK3PXP",
		});
		assert.deepEqual(await configured.json(), {
			credentialsConfigured: true,
			status: {
				state: "idle",
				lastCheckAtMs: null,
				lastCookieUpdateAtMs: null,
				lastAutoLoginAtMs: null,
				failureCode: null,
			},
		});
	});

	test("preserves blank fields during credential updates and clears plaintext", async () => {
		const active = fixture();
		active.store.encrypted = ENCRYPTED;
		active.store.status.credentialsConfigured = true;
		const response = await request(
			`/admin/accounts/${ACCOUNT_ID}/browser/credentials`,
			json("PUT", {
				email: "",
				password: "replacement",
				totpSecret: "",
			}),
			active.env,
		);
		assert.equal(response.status, 200);
		assert.deepEqual(active.getEncryptedInput(), {
			email: "old@example.com",
			password: "replacement",
			totpSecret: "JBSWY3DPEHPK3PXP",
		});
		assert.deepEqual(active.getDecrypted(), {
			email: "",
			password: "",
			totpSecret: "",
		});
	});

	test("fails closed without the master key and preserves encrypted data", async () => {
		const active = fixture();
		active.store.encrypted = ENCRYPTED;
		active.store.status.credentialsConfigured = true;
		const noCrypto = { ...active.env, BROWSER_CREDENTIAL_CRYPTO: undefined };
		for (const init of [
			json("PUT", {
				email: "owner@example.com",
				password: "password",
				totpSecret: "JBSWY3DPEHPK3PXP",
			}),
			{ method: "DELETE" },
		]) {
			const response = await request(
				`/admin/accounts/${ACCOUNT_ID}/browser/credentials`,
				init,
				noCrypto,
			);
			assert.equal(response.status, 503);
		}
		assert.deepEqual(active.store.encrypted, ENCRYPTED);
		assert.doesNotMatch(active.store.calls.join(","), /clearCredentials/);
	});

	test("clears credentials explicitly when the master key is available", async () => {
		const active = fixture();
		active.store.encrypted = ENCRYPTED;
		active.store.status.credentialsConfigured = true;
		const response = await request(
			`/admin/accounts/${ACCOUNT_ID}/browser/credentials`,
			{ method: "DELETE" },
			active.env,
		);
		assert.equal(response.status, 200);
		assert.equal(active.store.encrypted, null);
	});

	test("runs bounded helper commands and returns only the public noVNC URL", async () => {
		const active = fixture();
		const check = await request(
			`/admin/accounts/${ACCOUNT_ID}/browser/check`,
			{ method: "POST" },
			active.env,
		);
		assert.equal(check.status, 200);
		const open = await request(
			`/admin/accounts/${ACCOUNT_ID}/browser/open`,
			{ method: "POST" },
			active.env,
		);
		assert.deepEqual(await open.json(), {
			url: "http://127.0.0.1:6080/vnc.html",
		});
		const stop = await request(
			"/admin/browser/stop",
			{ method: "POST" },
			active.env,
		);
		assert.equal(stop.status, 200);
		assert.deepEqual(active.helperCalls, [
			`check:${ACCOUNT_ID}`,
			`open:${ACCOUNT_ID}`,
			"stop",
		]);
	});

	test("redacts legacy unsafe browser failure codes", async () => {
		const active = fixture();
		active.store.status.failureCode = "SQL token=private-cookie";
		const response = await request(
			`/admin/accounts/${ACCOUNT_ID}/browser/check`,
			{ method: "POST" },
			active.env,
		);
		assert.equal(response.status, 200);
		const text = await response.text();
		assert.doesNotMatch(text, /SQL token=private-cookie/i);
		assert.equal(
			(JSON.parse(text) as { status?: { failureCode?: unknown } }).status
				?.failureCode,
			null,
		);
	});

	test("requires exact account confirmation before deleting a profile", async () => {
		const active = fixture();
		const path = `/admin/accounts/${ACCOUNT_ID}/browser/profile`;
		const rejected = await request(
			path,
			json("DELETE", { confirmAccountId: "other" }),
			active.env,
		);
		assert.equal(rejected.status, 400);
		const deleted = await request(
			path,
			json("DELETE", { confirmAccountId: ACCOUNT_ID }),
			active.env,
		);
		assert.equal(deleted.status, 200);
		assert.deepEqual(active.helperCalls, [`delete:${ACCOUNT_ID}`]);
	});

	test("registers browser admin routes before the generic account handler", async () => {
		const active = fixture();
		const response = await handleApplicationRequest(
			new Request(
				`https://worker.example/admin/accounts/${ACCOUNT_ID}/browser/check`,
				{
					method: "POST",
					headers: { Authorization: `Bearer ${ADMIN_KEY}` },
				},
			),
			active.env,
			{ waitUntil() {} },
		);
		assert.equal(response.status, 200);
		assert.deepEqual(active.helperCalls, [`check:${ACCOUNT_ID}`]);
	});
});
