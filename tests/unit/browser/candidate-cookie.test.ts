import { describe, test } from "vitest";
import {
	CandidateCookieService,
	type CandidateCookieStore,
} from "../../../src/browser/candidate-cookie";
import {
	identityHashFromCookie,
	sha256Hex,
} from "../../../src/gemini/accounts/domain";
import type {
	GeminiAccountProbe,
	GeminiAccountVerifier,
} from "../../../src/gemini/accounts/probe";
import type { GeminiVerifiedBrowserCookieWrite } from "../../../src/gemini/accounts/types";
import { assert } from "../assertions.js";
import { baseGeminiClientConfig } from "../gemini/_support/client-fixtures.js";
import type { BrowserCredentialCrypto } from "../../../src/browser/types";
import {
	AccountPoolService,
	DEFAULT_CANDIDATE_COOKIE_VERIFIER,
} from "../../../src/gemini/accounts/pool";
import { verifyGeminiAccount } from "../../../src/gemini/accounts/probe";
import type { GeminiAccountStore } from "../../../src/gemini/accounts/types";
import { SqlGeminiAccountStore } from "../../../src/gemini/accounts/store-sql";

type CredentialCryptoModule = {
	createCredentialCryptoBinding(key: Uint8Array): BrowserCredentialCrypto;
};

const credentialCryptoModule = (await import(
	new URL("../../../server/credential-crypto.mjs", import.meta.url).href
)) as CredentialCryptoModule;
const sqliteModule = (await import(
	new URL("../../../server/sqlite-binding.mjs", import.meta.url).href
)) as {
	createSqliteBinding(config: {
		path: string;
		busyTimeoutMs: number;
	}): import("../../../src/gemini/accounts/types").SqlDatabaseLike & {
		close(): void;
	};
};

const NOW = 123_456;
const OLD_COOKIE = "__Secure-1PSID=old-psid; __Secure-1PSIDTS=old-ts";
const MODEL: GeminiAccountProbe["models"][number] = {
	modelId: "model-pro",
	displayName: "Pro",
	description: "verified",
	available: true,
	capacity: 1,
	capacityField: 13,
	modelNumber: 1,
	discoveryOrder: 0,
};

async function fixture(
	options: {
		psid?: string;
		psidts?: string;
		observedEmail?: string | null;
		storedEmail?: string | null;
		verify?: GeminiAccountVerifier;
		writeResult?: { changed: boolean; reason?: "conflict" };
		lastCookieUpdateAtMs?: number | null;
	} = {},
) {
	const psid = options.psid ?? "old-psid";
	const psidts = options.psidts ?? "old-ts";
	const writes: GeminiVerifiedBrowserCookieWrite[] = [];
	let refreshed = 0;
	const store: CandidateCookieStore = {
		async getBrowserCandidateAccount(accountId) {
			return {
				id: accountId,
				cookie_header: OLD_COOKIE,
				cookie_hash: await sha256Hex(OLD_COOKIE),
				identity_hash: await identityHashFromCookie(OLD_COOKIE),
				login_email_hash:
					options.storedEmail === undefined
						? await sha256Base64("owner@example.com")
						: options.storedEmail,
				last_cookie_update_at_ms: Object.hasOwn(options, "lastCookieUpdateAtMs")
					? (options.lastCookieUpdateAtMs ?? null)
					: 999,
			};
		},
		async replaceVerifiedBrowserCookie(_accountId, write) {
			writes.push(write);
			return (
				options.writeResult ?? { changed: write.cookieHeader !== OLD_COOKIE }
			);
		},
	};
	const verify =
		options.verify ??
		(async () => ({
			ok: true as const,
			probe: { statusCode: 1000, issue: null, models: [MODEL] },
		}));
	const service = new CandidateCookieService({
		store,
		baseConfig: baseGeminiClientConfig(),
		verifyAccount: verify,
		refreshPool: async () => {
			refreshed += 1;
		},
	});
	const result = await service.replace({
		accountId: "account-a",
		psid,
		psidts,
		observedEmail: options.observedEmail ?? null,
		nowMs: NOW,
	});
	return { result, writes, refreshed };
}

describe("verified browser candidate cookies", () => {
	test("keeps unchanged secret bytes while recording a verified ready check", async () => {
		const { result, writes, refreshed } = await fixture();
		assert.deepEqual(result, {
			ok: true,
			changed: false,
			state: "ready",
			lastCookieUpdateAtMs: 999,
		});
		assert.equal(writes.length, 1);
		assert.equal(writes[0]?.changed, false);
		assert.deepEqual(writes[0]?.probe.models, [MODEL]);
		assert.equal(refreshed, 1);
	});

	test("accepts a changed cookie for the same identity without an observed email", async () => {
		const { result, writes } = await fixture({ psidts: "new-ts" });
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.changed, true);
		assert.equal(writes.length, 1);
		assert.equal(writes[0]?.changed, true);
		assert.equal(writes[0]?.expectedCookieHash, await sha256Hex(OLD_COOKIE));
		assert.equal(
			writes[0]?.expectedIdentityHash,
			await identityHashFromCookie(OLD_COOKIE),
		);
	});

	test("accepts a changed identity only when canonical observed email matches configured credentials", async () => {
		const { result, writes } = await fixture({
			psid: "new-identity",
			psidts: "new-ts",
			observedEmail: "  OWNER@Example.COM ",
		});
		assert.equal(result.ok, true);
		assert.equal(writes.length, 1);
	});

	test("matches the Base64 email hash produced by the real credential binding", async () => {
		const encrypted = await credentialCryptoModule
			.createCredentialCryptoBinding(new Uint8Array(32).fill(7))
			.encrypt("account-a", {
				email: "owner@example.com",
				password: "password",
				totpSecret: "JBSWY3DPEHPK3PXP",
			});
		const { result, writes } = await fixture({
			psid: "new-identity",
			observedEmail: " OWNER@EXAMPLE.COM ",
			storedEmail: encrypted.emailHash,
		});
		assert.equal(result.ok, true);
		assert.equal(writes.length, 1);
	});

	test("rejects malformed or noncanonical stored Base64 hashes", async () => {
		for (const storedEmail of [
			"not-base64",
			Buffer.alloc(31).toString("base64"),
			`${Buffer.alloc(32).toString("base64")}\n`,
		]) {
			const { result, writes } = await fixture({
				psid: "new-identity",
				observedEmail: "owner@example.com",
				storedEmail,
			});
			assert.deepEqual(result, {
				ok: false,
				code: "browser_identity_mismatch",
			});
			assert.equal(writes.length, 0);
		}
	});

	for (const [name, options] of [
		[
			"changed identity without credentials",
			{ psid: "new", storedEmail: null },
		],
		["changed identity without observed email", { psid: "new" }],
		[
			"changed identity with the wrong observed email",
			{ psid: "new", observedEmail: "wrong@example.com" },
		],
	] as const) {
		test(`rejects ${name} without mutation`, async () => {
			const { result, writes, refreshed } = await fixture(options);
			assert.deepEqual(result, {
				ok: false,
				code: "browser_identity_mismatch",
			});
			assert.equal(writes.length, 0);
			assert.equal(refreshed, 0);
		});
	}

	for (const [reason, code] of [
		["missing_page_at_token", "browser_cookie_verification_failed"],
		["status_probe_failed", "browser_cookie_verification_failed"],
	] as const) {
		test(`rejects ${reason} without mutation`, async () => {
			const { result, writes } = await fixture({
				verify: async () => ({ ok: false, reason }),
			});
			assert.deepEqual(result, { ok: false, code });
			assert.equal(writes.length, 0);
		});
	}

	test("rejects a restricted Gemini status without mutation", async () => {
		const { result, writes } = await fixture({
			verify: async () => ({
				ok: true,
				probe: { statusCode: 1016, issue: "auth", models: [] },
			}),
		});
		assert.deepEqual(result, { ok: false, code: "browser_account_restricted" });
		assert.equal(writes.length, 0);
	});

	test("rejects a verifier success without a probe before mutation", async () => {
		const { result, writes } = await fixture({
			verify: async () => ({ ok: true }),
		});
		assert.deepEqual(result, {
			ok: false,
			code: "browser_cookie_verification_failed",
		});
		assert.equal(writes.length, 0);
	});

	test("maps verifier rejection to a safe failure without mutation", async () => {
		const { result, writes } = await fixture({
			verify: async () => {
				throw new Error("private network failure");
			},
		});
		assert.deepEqual(result, {
			ok: false,
			code: "browser_cookie_verification_failed",
		});
		assert.equal(writes.length, 0);
	});

	test("preserves null last-cookie-update for an unchanged candidate", async () => {
		const { result } = await fixture({ lastCookieUpdateAtMs: null });
		assert.deepEqual(result, {
			ok: true,
			changed: false,
			state: "ready",
			lastCookieUpdateAtMs: null,
		});
	});

	test("production pool factory owns the real verifier default and supports a test seam", async () => {
		assert.equal(DEFAULT_CANDIDATE_COOKIE_VERIFIER, verifyGeminiAccount);
		const calls: string[] = [];
		const store: CandidateCookieStore = {
			async getBrowserCandidateAccount() {
				calls.push("load");
				return {
					id: "account-a",
					cookie_header: OLD_COOKIE,
					cookie_hash: await sha256Hex(OLD_COOKIE),
					identity_hash: await identityHashFromCookie(OLD_COOKIE),
					login_email_hash: null,
					last_cookie_update_at_ms: null,
				};
			},
			async replaceVerifiedBrowserCookie() {
				throw new Error("unexpected mutation");
			},
		};
		const pool = new AccountPoolService(store as GeminiAccountStore, {
			rotateCookie: async () => new Response(null, { status: 500 }),
		});
		const service = pool.createCandidateCookieService(
			baseGeminiClientConfig(),
			async () => {
				calls.push("verify");
				return { ok: false, reason: "status_probe_failed" };
			},
		);
		assert.deepEqual(
			await service.replace({
				accountId: "account-a",
				psid: "old-psid",
				psidts: "new-ts",
				observedEmail: null,
				nowMs: NOW,
			}),
			{ ok: false, code: "browser_cookie_verification_failed" },
		);
		assert.deepEqual(calls, ["load", "verify"]);
	});

	for (const candidateKind of ["changed", "unchanged"] as const) {
		test(`rejects a concurrent account mutation for a ${candidateKind} candidate without side effects`, async () => {
			const db = sqliteModule.createSqliteBinding({
				path: ":memory:",
				busyTimeoutMs: 1000,
			});
			try {
				const originalCookie = OLD_COOKIE;
				const originalCookieHash = await sha256Hex(originalCookie);
				const originalIdentityHash =
					await identityHashFromCookie(originalCookie);
				await db
					.prepare(`INSERT INTO gemini_accounts (
						id, cookie_header, cookie_hash, identity_hash, created_at_ms, updated_at_ms
					) VALUES (?, ?, ?, ?, ?, ?)`)
					.bind(
						"race-account",
						originalCookie,
						originalCookieHash,
						originalIdentityHash,
						1,
						1,
					)
					.run();
				const store = new SqlGeminiAccountStore(db);
				const service = new CandidateCookieService({
					store,
					baseConfig: baseGeminiClientConfig(),
					verifyAccount: async () => {
						const concurrentCookie =
							"__Secure-1PSID=concurrent; __Secure-1PSIDTS=concurrent";
						await db
							.prepare(`UPDATE gemini_accounts SET
								cookie_header = ?, cookie_hash = ?, identity_hash = ?
								WHERE id = ?`)
							.bind(
								concurrentCookie,
								await sha256Hex(concurrentCookie),
								await identityHashFromCookie(concurrentCookie),
								"race-account",
							)
							.run();
						return {
							ok: true,
							probe: { statusCode: 1000, issue: null, models: [MODEL] },
						};
					},
				});
				assert.deepEqual(
					await service.replace({
						accountId: "race-account",
						psid: "old-psid",
						psidts: candidateKind === "changed" ? "new-ts" : "old-ts",
						observedEmail: null,
						nowMs: NOW,
					}),
					{ ok: false, code: "browser_cookie_conflict" },
				);
				assert.equal(
					await db
						.prepare("SELECT COUNT(*) FROM gemini_account_models")
						.first("COUNT(*)"),
					0,
				);
				assert.equal(
					await db
						.prepare("SELECT COUNT(*) FROM gemini_browser_accounts")
						.first("COUNT(*)"),
					0,
				);
			} finally {
				db.close();
			}
		});
	}

	test("does not misclassify a dependent model constraint failure as a cookie conflict", async () => {
		const db = sqliteModule.createSqliteBinding({
			path: ":memory:",
			busyTimeoutMs: 1000,
		});
		try {
			const cookieHash = await sha256Hex(OLD_COOKIE);
			await db
				.prepare(`INSERT INTO gemini_accounts (
					id, cookie_header, cookie_hash, identity_hash, created_at_ms, updated_at_ms
				) VALUES (?, ?, ?, ?, ?, ?)`)
				.bind(
					"model-conflict",
					OLD_COOKIE,
					cookieHash,
					await identityHashFromCookie(OLD_COOKIE),
					1,
					1,
				)
				.run();
			const service = new CandidateCookieService({
				store: new SqlGeminiAccountStore(db),
				baseConfig: baseGeminiClientConfig(),
				verifyAccount: async () => ({
					ok: true,
					probe: { statusCode: 1000, issue: null, models: [MODEL, MODEL] },
				}),
			});
			await assert.rejects(
				() =>
					service.replace({
						accountId: "model-conflict",
						psid: "old-psid",
						psidts: "new-ts",
						observedEmail: null,
						nowMs: NOW,
					}),
				/SQLite guarded batch failed/,
			);
			assert.equal(
				await db
					.prepare("SELECT cookie_hash FROM gemini_accounts WHERE id = ?")
					.bind("model-conflict")
					.first("cookie_hash"),
				cookieHash,
			);
			assert.equal(
				await db
					.prepare("SELECT COUNT(*) FROM gemini_account_models")
					.first("COUNT(*)"),
				0,
			);
		} finally {
			db.close();
		}
	});

	test("maps duplicate cookie or identity writes to a safe conflict", async () => {
		const { result } = await fixture({
			psidts: "new",
			writeResult: { changed: false, reason: "conflict" },
		});
		assert.deepEqual(result, { ok: false, code: "browser_cookie_conflict" });
	});

	test("rejects non-bare cookie values before account lookup", async () => {
		for (const psid of [
			"",
			"__Secure-1PSID=value",
			"value=x",
			"value;other",
			"value with-space",
			"value\tcontrol",
			'value"quote',
			"value,comma",
			"value\\slash",
			"value-é",
		]) {
			const { result, writes } = await fixture({ psid });
			assert.deepEqual(result, {
				ok: false,
				code: "browser_candidate_invalid",
			});
			assert.equal(writes.length, 0);
		}
	});

	test("accepts the RFC 6265 cookie-octet boundaries used by Google cookies", async () => {
		const value =
			"!#$%&'()*+-./0123456789:<>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";
		const { result } = await fixture({ psidts: value });
		assert.equal(result.ok, true);
	});
});

async function sha256Base64(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Buffer.from(digest).toString("base64");
}
