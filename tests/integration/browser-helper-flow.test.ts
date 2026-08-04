import { randomBytes } from "node:crypto";
import { describe, test } from "vitest";
import { handleApplicationRequest } from "../../src/app";
import { CandidateCookieService } from "../../src/browser/candidate-cookie";
import { SqlBrowserAccountStore } from "../../src/browser/store";
import type { BrowserCredentialCrypto } from "../../src/browser/types";
import type { AppEnv } from "../../src/config";
import {
	identityHashFromCookie,
	sha256Hex,
} from "../../src/gemini/accounts/domain";
import { SqlGeminiAccountStore } from "../../src/gemini/accounts/store-sql";
import type { SqlDatabaseLike } from "../../src/gemini/accounts/types";
import { assert } from "../unit/assertions.js";

type SqliteBinding = SqlDatabaseLike & { close(): void };
type CredentialCryptoModule = {
	createCredentialCryptoBinding(key: Uint8Array): BrowserCredentialCrypto;
};

const sqliteModule = (await import(
	new URL("../../server/sqlite-binding.mjs", import.meta.url).href
)) as {
	createSqliteBinding(config: {
		path: string;
		busyTimeoutMs: number;
	}): SqliteBinding;
};
const credentialCryptoModule = (await import(
	new URL("../../server/credential-crypto.mjs", import.meta.url).href
)) as CredentialCryptoModule;
const { decryptBrowserCredentials } = (await import(
	new URL("../../browser-helper/crypto.mjs", import.meta.url).href
)) as {
	decryptBrowserCredentials(
		masterKey: Uint8Array,
		accountId: string,
		envelope: unknown,
	): { email: string; password: string; totpSecret: string };
};
const schedulerModulePath: string = "../../browser-helper/scheduler.mjs";
const { createBrowserScheduler } = await import(schedulerModulePath);
const feishuModulePath: string = "../../browser-helper/feishu.mjs";
const { createFeishuNotifier, feishuSignature } = await import(
	feishuModulePath
);
const clientModulePath: string = "../../browser-helper/web2gem-client.mjs";
const { createWeb2gemClient } = await import(clientModulePath);

describe("browser helper recovery flow", () => {
	test("keeps credentials and cookies redacted across manual action and recovery", async () => {
		const masterKey = randomBytes(32);
		const password = `pw-${randomBytes(18).toString("hex")}`;
		const totpSecret = base32(randomBytes(20));
		const email = `${randomBytes(8).toString("hex")}@example.test`;
		const internalToken = `internal-${randomBytes(24).toString("hex")}`;
		const adminKey = `admin-${randomBytes(24).toString("hex")}`;
		const signingSecret = `sign-${randomBytes(24).toString("hex")}`;
		const webhookToken = randomBytes(20).toString("hex");
		const webhookUrl = `https://open.feishu.cn/open-apis/bot/v2/hook/${webhookToken}`;
		const oldPsid = randomBytes(24).toString("base64url");
		const oldPsidts = randomBytes(24).toString("base64url");
		const nextPsid = randomBytes(24).toString("base64url");
		const nextPsidts = randomBytes(24).toString("base64url");
		const disabledPsid = randomBytes(24).toString("base64url");
		const disabledPsidts = randomBytes(24).toString("base64url");
		const oldCookie = `__Secure-1PSID=${oldPsid}; __Secure-1PSIDTS=${oldPsidts}`;
		const nextCookie = `__Secure-1PSID=${nextPsid}; __Secure-1PSIDTS=${nextPsidts}`;
		const accountId = `account-${randomBytes(8).toString("hex")}`;
		const db = sqliteModule.createSqliteBinding({
			path: ":memory:",
			busyTimeoutMs: 1_000,
		});
		const captures: string[] = [];
		const privilegedCaptures: string[] = [];
		const operationalLogs: string[] = [];
		const feishuBodies: Array<Record<string, unknown>> = [];
		try {
			await db
				.prepare(`INSERT INTO gemini_accounts (
					id, label, enabled, cookie_header, cookie_hash, identity_hash,
					created_at_ms, updated_at_ms
				) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`)
				.bind(
					accountId,
					"Primary",
					oldCookie,
					await sha256Hex(oldCookie),
					await identityHashFromCookie(oldCookie),
					1,
					1,
				)
				.run();

			const browserStore = new SqlBrowserAccountStore(db);
			const crypto =
				credentialCryptoModule.createCredentialCryptoBinding(masterKey);
			const candidateService = new CandidateCookieService({
				store: new SqlGeminiAccountStore(db),
				baseConfig: {},
				verifyAccount: async () => ({
					ok: true as const,
					probe: {
						statusCode: 1_000,
						issue: null,
						models: [
							{
								modelId: "model-pro",
								displayName: "Pro",
								description: "verified capability",
								available: true,
								capacity: 2,
								capacityField: 13,
								modelNumber: 1,
								discoveryOrder: 0,
							},
						],
					},
				}),
			});
			const env = {
				ADMIN_KEY: adminKey,
				BROWSER_HELPER_INTERNAL_TOKEN: internalToken,
				ACCOUNT_DB: db,
				BROWSER_ACCOUNT_STORE: browserStore,
				BROWSER_CREDENTIAL_CRYPTO: crypto,
				BROWSER_CANDIDATE_COOKIE_SERVICE: candidateService,
			} satisfies AppEnv;
			const appFetch = async (
				input: RequestInfo | URL,
				init?: RequestInit,
			): Promise<Response> => {
				const request = new Request(input, init);
				const response = await handleApplicationRequest(request, env, {
					waitUntil() {},
				});
				const path = new URL(request.url).pathname;
				captures.push(`${request.method} ${path} ${response.status}`);
				const body = await response.clone().text();
				if (response.ok && path.endsWith("/session-cookie")) {
					// This private response intentionally transports the stored CK to the helper.
				} else if (response.ok && path.endsWith("/credentials"))
					privilegedCaptures.push(body);
				else captures.push(body);
				return response;
			};

			const configured = await handleApplicationRequest(
				new Request(
					`https://web2gem.test/admin/accounts/${encodeURIComponent(accountId)}/browser/credentials`,
					{
						method: "PUT",
						headers: {
							Authorization: `Bearer ${adminKey}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ email, password, totpSecret }),
					},
				),
				env,
				{ waitUntil() {} },
			);
			assert.equal(configured.status, 200);
			captures.push(await configured.text());

			const denied = await appFetch(
				new Request(
					`http://web2gem/internal/browser/accounts/${encodeURIComponent(accountId)}/credentials`,
				),
			);
			assert.equal(denied.status, 401);
			captures.push(await denied.text());

			const encryptedResponse = await appFetch(
				new Request(
					`http://web2gem/internal/browser/accounts/${encodeURIComponent(accountId)}/credentials`,
					{ headers: { Authorization: `Bearer ${internalToken}` } },
				),
			);
			const encrypted = (await encryptedResponse.json()) as {
				version: 1;
				ciphertext: string;
				nonce: string;
				emailHash: string;
			};
			assert.deepEqual(Object.keys(encrypted).sort(), [
				"ciphertext",
				"emailHash",
				"nonce",
				"version",
			]);
			assert.deepEqual(
				decryptBrowserCredentials(masterKey, accountId, encrypted),
				{
					email,
					password,
					totpSecret,
				},
			);
			const client = createWeb2gemClient(
				{
					web2gemInternalUrl: "http://web2gem/",
					internalToken,
				},
				{ fetch: appFetch },
			);
			const notifier = createFeishuNotifier(
				{
					feishu: { webhookUrl, signingSecret },
					novncPublicUrl: "http://127.0.0.1:6080/vnc.html",
				},
				{
					client,
					clock: () => Date.UTC(2026, 7, 2, 12),
					async fetch(_input: RequestInfo | URL, init?: RequestInit) {
						feishuBodies.push(JSON.parse(String(init?.body)));
						return Response.json({ code: 0 });
					},
				},
			);
			let jobNumber = 0;
			const scheduler = createBrowserScheduler(
				{
					checkIntervalSec: 21_600,
					checkJitterSec: 0,
					autoLoginMaxAttemptsPerDay: 2,
					maxClockSkewSec: 120,
				},
				{
					client,
					notifier,
					owner: "integration-owner",
					clock: () => Date.UTC(2026, 7, 2, 12),
					decryptCredentials: (id: string, envelope: unknown) =>
						decryptBrowserCredentials(masterKey, id, envelope),
					browser: {
						async startHeadless() {
							const job = ++jobNumber;
							return {
								pages: () => [{ job }],
								async cookies() {
									return [];
								},
								async addCookies() {},
							};
						},
						async startVisible() {
							throw new Error("unexpected visible browser");
						},
						async close() {},
					},
					async runLogin(input: {
						page: { job: number };
						credentials?: {
							email: string;
							password: string;
							totpSecret: string;
						};
						beforeSubmit?: () => Promise<void>;
					}) {
						if (input.page.job === 1 && !input.credentials)
							return { ok: false, code: "login_failed" };
						if (input.page.job === 1) {
							assert.deepEqual(input.credentials, {
								email,
								password,
								totpSecret,
							});
							await input.beforeSubmit?.();
							return { ok: false, code: "captcha" };
						}
						if (input.page.job === 2) return { ok: false, code: "captcha" };
						return {
							ok: true,
							psid: nextPsid,
							psidts: nextPsidts,
							observedEmail: email,
							automaticLoginUsed: false,
						};
					},
					onOperationalError: (code: string) => operationalLogs.push(code),
				},
			);

			for (let index = 0; index < 4; index += 1)
				await scheduler.enqueue({ accountId, mode: "manual_check" });
			assert.equal(feishuBodies.length, 2);
			const firstNotification = feishuBodies[0] as {
				timestamp: string;
				sign: string;
				content: { text: string };
			};
			const recoveryNotification = feishuBodies[1] as {
				content: { text: string };
			};
			assert.equal(
				firstNotification.sign,
				feishuSignature(Number(firstNotification.timestamp), signingSecret),
			);
			assert.match(firstNotification.content.text, /captcha/);
			assert.match(recoveryNotification.content.text, /ready/);

			const account = await db
				.prepare(`SELECT enabled, cookie_header, cookie_hash, identity_hash,
					account_status_code FROM gemini_accounts WHERE id = ?`)
				.bind(accountId)
				.first<{
					enabled: number;
					cookie_header: string;
					cookie_hash: string;
					identity_hash: string;
					account_status_code: number;
				}>();
			assert.equal(account?.cookie_header, nextCookie);
			assert.equal(account?.cookie_hash, await sha256Hex(nextCookie));
			assert.equal(account?.identity_hash, await sha256Hex(nextPsid));
			assert.equal(account?.account_status_code, 1_000);
			const models = await db
				.prepare(`SELECT model_id, display_name, available, capacity
					FROM gemini_account_models WHERE account_id = ?`)
				.bind(accountId)
				.all<{
					model_id: string;
					display_name: string;
					available: number;
					capacity: number;
				}>();
			assert.deepEqual(models.results, [
				{
					model_id: "model-pro",
					display_name: "Pro",
					available: 1,
					capacity: 2,
				},
			]);
			const browser = await db
				.prepare(`SELECT browser_state, notification_state, failure_code,
					last_cookie_update_at_ms, auth_failure_count
					FROM gemini_browser_accounts WHERE account_id = ?`)
				.bind(accountId)
				.first<{
					browser_state: string;
					notification_state: string;
					failure_code: string | null;
					last_cookie_update_at_ms: number;
					auth_failure_count: number;
				}>();
			assert.deepEqual(
				{ ...browser, last_cookie_update_at_ms: null },
				{
					browser_state: "ready",
					notification_state: "ready",
					failure_code: null,
					last_cookie_update_at_ms: null,
					auth_failure_count: 0,
				},
			);
			assert.equal(
				Number.isSafeInteger(browser?.last_cookie_update_at_ms) &&
					Number(browser?.last_cookie_update_at_ms) > 0,
				true,
			);

			assert.equal(await client.acquireLease(accountId, "owner-a", 300), true);
			assert.equal(await client.acquireLease(accountId, "owner-b", 300), false);
			await client.releaseLease(accountId, "owner-b");
			assert.equal(await client.acquireLease(accountId, "owner-b", 300), false);
			await client.releaseLease(accountId, "owner-a");
			assert.equal(await client.acquireLease(accountId, "owner-b", 300), true);
			await db
				.prepare("UPDATE gemini_accounts SET enabled = 0 WHERE id = ?")
				.bind(accountId)
				.run();
			await client.releaseLease(accountId, "owner-b");
			assert.equal(await client.acquireLease(accountId, "owner-c", 300), false);
			assert.deepEqual(await client.listAccounts(), []);
			await assert.rejects(
				() =>
					client.submitCandidateCookie(accountId, {
						psid: disabledPsid,
						psidts: disabledPsidts,
						observedEmail: email,
					}),
				/web2gem request failed/,
			);
			assert.equal(
				await db
					.prepare("SELECT cookie_header FROM gemini_accounts WHERE id = ?")
					.bind(accountId)
					.first<string>("cookie_header"),
				nextCookie,
			);

			captures.push(
				JSON.stringify(feishuBodies),
				JSON.stringify(operationalLogs),
			);
			assertRedacted(captures, [
				password,
				totpSecret,
				oldPsid,
				oldPsidts,
				nextPsid,
				nextPsidts,
				disabledPsid,
				disabledPsidts,
				masterKey.toString("base64"),
				internalToken,
				webhookToken,
				signingSecret,
				encrypted.ciphertext,
			]);
			assertRedacted(privilegedCaptures, [
				password,
				totpSecret,
				oldPsid,
				oldPsidts,
				nextPsid,
				nextPsidts,
				disabledPsid,
				disabledPsidts,
				masterKey.toString("base64"),
				internalToken,
				webhookToken,
				signingSecret,
			]);
		} finally {
			db.close();
		}
	});
});

function base32(bytes: Uint8Array): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	let bits = 0;
	let value = 0;
	let output = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
	return output;
}

function assertRedacted(
	captures: readonly string[],
	secrets: readonly string[],
) {
	const combined = captures.join("\n");
	for (const secret of secrets) assert.equal(combined.includes(secret), false);
}
