import type { DatabaseSync } from "node:sqlite";
import { describe, test } from "vitest";
import { SqlBrowserAccountStore } from "../../../src/browser/store";
import type { SqlDatabaseLike } from "../../../src/gemini/accounts/types";
import { assert } from "../assertions.js";
import { RecordingSql } from "../gemini/accounts/_support/store-fixtures.js";

type SqliteBinding = SqlDatabaseLike & { close(): void };
type CreateSqliteBinding = (
	config: { path: string; busyTimeoutMs: number },
	options?: { Database?: typeof DatabaseSync },
) => SqliteBinding;

const sqliteModule = (await import(
	new URL("../../../server/sqlite-binding.mjs", import.meta.url).href
)) as { createSqliteBinding: CreateSqliteBinding };

describe("SQL browser account store", () => {
	test("derives safe status only from a complete credential envelope", async () => {
		const db = new RecordingSql([
			{
				sql: /SELECT credential_ciphertext IS NOT NULL AND credential_nonce IS NOT NULL AND credential_version = 1 AND login_email_hash IS NOT NULL AS credentials_configured, browser_state, last_check_at_ms, last_cookie_update_at_ms, last_auto_login_at_ms, failure_code FROM gemini_browser_accounts WHERE account_id = \? LIMIT 1/,
				binds: ["configured"],
				operation: "first",
				result: {
					credentials_configured: 1,
					browser_state: "ready",
					last_check_at_ms: 10,
					last_cookie_update_at_ms: 11,
					last_auto_login_at_ms: 12,
					failure_code: null,
				},
			},
			{
				sql: /SELECT credential_ciphertext IS NOT NULL .* FROM gemini_browser_accounts WHERE account_id = \? LIMIT 1/,
				binds: ["malformed"],
				operation: "first",
				result: {
					credentials_configured: 0,
					browser_state: "not-a-browser-state",
					last_check_at_ms: null,
					last_cookie_update_at_ms: null,
					last_auto_login_at_ms: null,
					failure_code: 42,
				},
			},
			{
				sql: /SELECT credential_ciphertext IS NOT NULL .* FROM gemini_browser_accounts WHERE account_id = \? LIMIT 1/,
				binds: ["missing"],
				operation: "first",
				result: null,
			},
		]);
		const store = new SqlBrowserAccountStore(db);

		assert.deepEqual(await store.getStatus("configured"), {
			credentialsConfigured: true,
			state: "ready",
			lastCheckAtMs: 10,
			lastCookieUpdateAtMs: 11,
			lastAutoLoginAtMs: 12,
			failureCode: null,
		});
		assert.deepEqual(await store.getStatus("malformed"), {
			credentialsConfigured: false,
			state: "idle",
			lastCheckAtMs: null,
			lastCookieUpdateAtMs: null,
			lastAutoLoginAtMs: null,
			failureCode: null,
		});
		assert.equal(await store.getStatus("missing"), null);
		db.assertDrained();
	});

	test("puts, reads, and clears the exact versioned credential envelope", async () => {
		const encrypted = {
			version: 1 as const,
			ciphertext: "ciphertext-secret",
			nonce: "nonce-secret",
			emailHash: "email-hash-secret",
		};
		const db = new RecordingSql([
			{
				sql: /INSERT INTO gemini_browser_accounts .* ON CONFLICT\(account_id\) DO UPDATE SET credential_ciphertext = excluded\.credential_ciphertext, credential_nonce = excluded\.credential_nonce, credential_version = excluded\.credential_version, login_email_hash = excluded\.login_email_hash, updated_at_ms = excluded\.updated_at_ms/,
				binds: [
					"account-a",
					encrypted.ciphertext,
					encrypted.nonce,
					encrypted.version,
					encrypted.emailHash,
					100,
				],
				operation: "run",
			},
			{
				sql: /SELECT credential_ciphertext, credential_nonce, credential_version, login_email_hash FROM gemini_browser_accounts WHERE account_id = \? LIMIT 1/,
				binds: ["account-a"],
				operation: "first",
				result: {
					credential_ciphertext: encrypted.ciphertext,
					credential_nonce: encrypted.nonce,
					credential_version: encrypted.version,
					login_email_hash: encrypted.emailHash,
				},
			},
			{
				sql: /INSERT INTO gemini_browser_accounts .* ON CONFLICT\(account_id\) DO UPDATE SET credential_ciphertext = NULL, credential_nonce = NULL, credential_version = NULL, login_email_hash = NULL, updated_at_ms = excluded\.updated_at_ms/,
				binds: ["account-a", 101],
				operation: "run",
			},
		]);
		const store = new SqlBrowserAccountStore(db);

		await store.putCredentials("account-a", encrypted, 100);
		assert.deepEqual(
			await store.getEncryptedCredentials("account-a"),
			encrypted,
		);
		await store.clearCredentials("account-a", 101);
		assert.doesNotMatch(db.records[0]?.sql || "", /browser_state\s*=/);
		assert.doesNotMatch(db.records[2]?.sql || "", /browser_state\s*=/);
		db.assertDrained();
	});

	test("rejects malformed credential rows at the SQL trust boundary", async () => {
		const db = new RecordingSql([
			{
				sql: /SELECT credential_ciphertext, credential_nonce, credential_version, login_email_hash FROM gemini_browser_accounts WHERE account_id = \? LIMIT 1/,
				binds: ["account-a"],
				operation: "first",
				result: {
					credential_ciphertext: 123,
					credential_nonce: "nonce",
					credential_version: 1,
					login_email_hash: "hash",
				},
			},
		]);

		assert.equal(
			await new SqlBrowserAccountStore(db).getEncryptedCredentials("account-a"),
			null,
		);
		db.assertDrained();
	});

	test("lists only enabled accounts using a secret-free projection", async () => {
		const db = new RecordingSql([
			{
				sql: /SELECT a\.id AS account_id, a\.label, COALESCE\(b\.credential_ciphertext IS NOT NULL AND b\.credential_nonce IS NOT NULL AND b\.credential_version = 1 AND b\.login_email_hash IS NOT NULL, 0\) AS credentials_configured, .* FROM gemini_accounts a LEFT JOIN gemini_browser_accounts b ON b\.account_id = a\.id WHERE a\.enabled = 1 ORDER BY/,
				binds: [],
				operation: "all",
				result: {
					results: [
						{
							account_id: "account-a",
							label: null,
							credentials_configured: 0,
							browser_state: "idle",
							last_check_at_ms: null,
							last_cookie_update_at_ms: null,
							last_auto_login_at_ms: null,
							failure_code: null,
							auth_failure_count: 0,
							auto_login_attempt_date: null,
							auto_login_attempt_count: 0,
							notification_state: "manual_action_required",
						},
						{
							account_id: "account-b",
							label: "Unsafe notification fixture",
							credentials_configured: 0,
							browser_state: "error",
							last_check_at_ms: null,
							last_cookie_update_at_ms: null,
							last_auto_login_at_ms: null,
							failure_code: null,
							auth_failure_count: 0,
							auto_login_attempt_date: null,
							auto_login_attempt_count: 0,
							notification_state: "token=must-not-project",
						},
					],
				},
			},
		]);
		const result = await new SqlBrowserAccountStore(db).listScheduled(500);

		assert.equal(result[0]?.accountId, "account-a");
		assert.equal(result[0]?.status.credentialsConfigured, false);
		assert.equal(result[0]?.notificationState, "manual_action_required");
		assert.equal(result[1]?.notificationState, null);
		assert.match(db.records[0]?.sql || "", /b\.notification_state/);
		assert.doesNotMatch(
			db.records[0]?.sql || "",
			/b\.(?:credential_ciphertext|credential_nonce|login_email_hash)\s*(?:,|\bAS\b)|cookie_header|cookie_hash/i,
		);
		assert.doesNotMatch(
			db.records[0]?.sql || "",
			/b\.(?:credential_ciphertext|credential_nonce|login_email_hash)\s+(?!IS\b)[A-Za-z_]\w*/i,
		);
		assert.doesNotMatch(
			JSON.stringify(result),
			/ciphertext|nonce|emailHash|cookieHeader|cookieHash|internalToken|must-not-project/,
		);
		db.assertDrained();
	});

	test("trusts only a matching lease RETURNING row", async () => {
		const leaseSql =
			/INSERT INTO gemini_browser_accounts .* RETURNING account_id/;
		const binds = ["account-a", "owner-a", 200, 100, 100, "owner-a"];
		const db = new RecordingSql([
			{
				sql: leaseSql,
				binds,
				operation: "run",
				result: { results: [] },
			},
			{
				sql: leaseSql,
				binds,
				operation: "run",
				result: { results: [{ account_id: "account-a" }] },
			},
			{
				sql: leaseSql,
				binds,
				operation: "run",
				result: { results: [{ account_id: "account-b" }] },
			},
			{
				sql: leaseSql,
				binds,
				operation: "run",
				result: { results: [{ account_id: 42 }] },
			},
			{
				sql: leaseSql,
				binds,
				operation: "run",
				result: {
					results: [{ account_id: "account-a" }, { account_id: "account-a" }],
				},
			},
		]);
		const store = new SqlBrowserAccountStore(db);

		assert.equal(
			await store.tryAcquireLease("account-a", "owner-a", 200, 100),
			false,
		);
		assert.equal(
			await store.tryAcquireLease("account-a", "owner-a", 200, 100),
			true,
		);
		assert.equal(
			await store.tryAcquireLease("account-a", "owner-a", 200, 100),
			false,
		);
		assert.equal(
			await store.tryAcquireLease("account-a", "owner-a", 200, 100),
			false,
		);
		assert.equal(
			await store.tryAcquireLease("account-a", "owner-a", 200, 100),
			false,
		);
		db.assertDrained();
	});

	test("atomically denies capped attempts and rejects malformed RETURNING", async () => {
		const attemptSql =
			/INSERT INTO gemini_browser_accounts .* RETURNING auto_login_attempt_count/;
		const db = new RecordingSql([
			{
				sql: attemptSql,
				binds: ["account-a", "2026-07-31", 100, 2],
				operation: "run",
				result: { results: [] },
			},
			{
				sql: attemptSql,
				binds: ["account-a", "2026-07-31", 101, 2],
				operation: "run",
				result: { results: [{ auto_login_attempt_count: "2" }] },
			},
		]);
		const store = new SqlBrowserAccountStore(db);

		assert.deepEqual(
			await store.recordAutoLoginAttempt("account-a", "2026-07-31", 2, 100),
			{ reserved: false, count: 2 },
		);
		await assert.rejects(
			store.recordAutoLoginAttempt("account-a", "2026-07-31", 2, 101),
			"SQL browser attempt update returned no count",
		);
		db.assertDrained();
	});

	test("updates status with a fixed safe column set", async () => {
		const db = new RecordingSql([
			{
				sql: /INSERT INTO gemini_browser_accounts .* ON CONFLICT\(account_id\) DO UPDATE SET browser_state = excluded\.browser_state, last_check_at_ms = excluded\.last_check_at_ms, last_cookie_update_at_ms = excluded\.last_cookie_update_at_ms, last_auto_login_at_ms = excluded\.last_auto_login_at_ms, auth_failure_count = excluded\.auth_failure_count, notification_state = excluded\.notification_state, failure_code = excluded\.failure_code, updated_at_ms = excluded\.updated_at_ms/,
				binds: [
					"account-a",
					"error",
					10,
					11,
					12,
					2,
					"error",
					"x".repeat(128),
					13,
				],
				operation: "run",
			},
		]);
		await new SqlBrowserAccountStore(db).writeStatus("account-a", {
			state: "error",
			lastCheckAtMs: 10,
			lastCookieUpdateAtMs: 11,
			lastAutoLoginAtMs: 12,
			authFailureCount: 2,
			notificationState: "error",
			failureCode: "x".repeat(200),
			nowMs: 13,
		});
		db.assertDrained();
	});

	test("CAS-updates only notification state while the browser state still matches", async () => {
		const sql =
			/UPDATE gemini_browser_accounts SET notification_state = \?, updated_at_ms = \? WHERE account_id = \? AND browser_state = \? RETURNING account_id/;
		const db = new RecordingSql([
			{
				sql,
				binds: ["error", 20, "account-a", "error"],
				operation: "run",
				result: { results: [{ account_id: "account-a" }] },
			},
			{
				sql,
				binds: ["error", 21, "account-a", "error"],
				operation: "run",
				result: { results: [] },
			},
		]);
		const store = new SqlBrowserAccountStore(db);

		assert.equal(
			await store.patchNotificationState("account-a", "error", "error", 20),
			true,
		);
		assert.equal(
			await store.patchNotificationState("account-a", "error", "error", 21),
			false,
		);
		assert.doesNotMatch(
			db.records[0]?.sql || "",
			/last_check|last_cookie|last_auto_login|auth_failure|failure_code|SET\s+browser_state\s*=/,
		);
		db.assertDrained();
	});

	test("atomically owns leases, counts date-bucket attempts, and cascades deletes", async () => {
		const db = sqliteModule.createSqliteBinding({
			path: ":memory:",
			busyTimeoutMs: 1000,
		});
		try {
			await db
				.prepare(`INSERT INTO gemini_accounts (
				id, cookie_header, cookie_hash, identity_hash, created_at_ms, updated_at_ms
			) VALUES (?, ?, ?, ?, ?, ?)`)
				.bind("account-a", "cookie", "cookie-hash", "identity-hash", 1, 1)
				.run();
			const store = new SqlBrowserAccountStore(db);

			assert.equal(
				await store.tryAcquireLease("account-a", "owner-a", 200, 100),
				true,
			);
			assert.equal(
				await store.tryAcquireLease("account-a", "owner-b", 250, 101),
				false,
			);
			assert.deepEqual(await store.getStatus("account-a"), {
				credentialsConfigured: false,
				state: "idle",
				lastCheckAtMs: null,
				lastCookieUpdateAtMs: null,
				lastAutoLoginAtMs: null,
				failureCode: null,
			});
			assert.equal(
				await store.tryAcquireLease("account-a", "owner-b", 300, 200),
				true,
			);
			assert.equal(
				await store.tryAcquireLease("account-a", "owner-a", 301, 201),
				false,
			);
			assert.equal(
				await store.tryAcquireLease("account-a", "owner-b", 302, 202),
				true,
			);
			await store.releaseLease("account-a", "owner-a");
			assert.equal(
				await store.tryAcquireLease("account-a", "owner-a", 303, 203),
				false,
			);
			await store.releaseLease("account-a", "owner-b");
			assert.equal(
				await store.tryAcquireLease("account-a", "owner-a", 304, 204),
				true,
			);

			assert.deepEqual(
				await store.recordAutoLoginAttempt("account-a", "2026-07-31", 2, 110),
				{ reserved: true, count: 1 },
			);
			assert.deepEqual(
				await store.recordAutoLoginAttempt("account-a", "2026-07-31", 2, 111),
				{ reserved: true, count: 2 },
			);
			assert.deepEqual(
				await store.recordAutoLoginAttempt("account-a", "2026-07-31", 2, 112),
				{ reserved: false, count: 2 },
			);
			assert.deepEqual(
				await store.recordAutoLoginAttempt("account-a", "2026-08-01", 2, 113),
				{ reserved: true, count: 1 },
			);

			await db
				.prepare("DELETE FROM gemini_accounts WHERE id = ?")
				.bind("account-a")
				.run();
			assert.equal(await store.getStatus("account-a"), null);
		} finally {
			db.close();
		}
	});
});
