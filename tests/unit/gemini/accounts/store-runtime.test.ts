import { describe, test } from "vitest";
import { sha256Hex } from "../../../../src/gemini/accounts/domain";
import { SqlGeminiAccountStore } from "../../../../src/gemini/accounts/store-sql";
import { assert } from "../../assertions.js";
import {
	accountSqlRow,
	durableIssues,
	mutationResult,
	poolVersionExpectation,
	RecordingSql,
} from "./_support/store-fixtures.js";

describe("SQL Gemini account runtime store", () => {
	test("loads candidate account secrets with only browser email metadata", async () => {
		const row = {
			id: "first",
			cookie_header: "cookie",
			cookie_hash: "cookie-hash",
			identity_hash: "identity-hash",
			login_email_hash: "email-hash",
			last_cookie_update_at_ms: 555,
		};
		const db = new RecordingSql([
			{
				sql: /SELECT a\.id, a\.cookie_header, a\.cookie_hash, a\.identity_hash, b\.login_email_hash, b\.last_cookie_update_at_ms FROM gemini_accounts a LEFT JOIN gemini_browser_accounts b ON b\.account_id = a\.id WHERE a\.id = \? LIMIT 1/,
				binds: ["first"],
				operation: "first",
				result: row,
			},
		]);
		assert.deepEqual(
			await new SqlGeminiAccountStore(db).getBrowserCandidateAccount("first"),
			row,
		);
		db.assertDrained();
	});

	test("atomically replaces a verified browser cookie and probe capabilities", async () => {
		const write = {
			cookieHeader: "__Secure-1PSID=new; __Secure-1PSIDTS=new-ts",
			cookieHash: "new-cookie-hash",
			identityHash: "new-identity-hash",
			changed: true,
			probe: {
				statusCode: 1000,
				issue: null,
				models: [
					{
						modelId: "model-pro",
						displayName: "Pro",
						description: "verified",
						available: true,
						capacity: 1,
						capacityField: 13,
						modelNumber: 1,
						discoveryOrder: 0,
					},
				],
			},
			nowMs: 6000,
		};
		const db = new RecordingSql([
			{
				sql: /UPDATE gemini_accounts SET cookie_header = \?, cookie_hash = \?, identity_hash = \?, issue = NULL, cooldown_until_ms = NULL, last_issue_at_ms = NULL, last_refresh_at_ms = \?, account_status_code = \?, status_checked_at_ms = \?, last_refresh_attempt_at_ms = \?, last_refresh_success_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [
					write.cookieHeader,
					write.cookieHash,
					write.identityHash,
					6000,
					1000,
					6000,
					6000,
					6000,
					6000,
					"first",
				],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: "DELETE FROM gemini_account_models WHERE account_id = ?",
				binds: ["first"],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: /INSERT INTO gemini_account_models/,
				binds: ["first", "model-pro", "Pro", "verified", 1, 1, 13, 1, 0, 6000],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: /INSERT INTO gemini_browser_accounts .*ON CONFLICT\(account_id\) DO UPDATE SET browser_state = 'ready'.*last_check_at_ms = excluded\.last_check_at_ms.*last_cookie_update_at_ms = excluded\.last_cookie_update_at_ms.*auth_failure_count = 0.*failure_code = NULL/,
				binds: ["first", 6000, 6000, 6000],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(6000, "unconditional"),
		]);
		assert.deepEqual(
			await new SqlGeminiAccountStore(db).replaceVerifiedBrowserCookie(
				"first",
				write,
			),
			{ changed: true },
		);
		db.assertBatches([[0, 1, 2, 3, 4]]);
		db.assertDrained();
	});

	test("does not rewrite secret columns for an unchanged verified cookie", async () => {
		const write = {
			cookieHeader: "secret",
			cookieHash: "hash",
			identityHash: "identity",
			changed: false,
			probe: { statusCode: 1000, issue: null, models: [] },
			nowMs: 7000,
		};
		const db = new RecordingSql([
			{
				sql: /UPDATE gemini_accounts SET issue = NULL, cooldown_until_ms = NULL, last_issue_at_ms = NULL, last_refresh_at_ms = \?, account_status_code = \?, status_checked_at_ms = \?, last_refresh_attempt_at_ms = \?, last_refresh_success_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [7000, 1000, 7000, 7000, 7000, 7000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: "DELETE FROM gemini_account_models WHERE account_id = ?",
				binds: ["first"],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: /INSERT INTO gemini_browser_accounts \( account_id, browser_state, last_check_at_ms, auth_failure_count, notification_state, failure_code, updated_at_ms \).*ON CONFLICT\(account_id\) DO UPDATE SET browser_state = 'ready', last_check_at_ms = excluded\.last_check_at_ms, auth_failure_count = 0/,
				binds: ["first", 7000, 7000],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(7000, "unconditional"),
		]);
		assert.deepEqual(
			await new SqlGeminiAccountStore(db).replaceVerifiedBrowserCookie(
				"first",
				write,
			),
			{ changed: false },
		);
		assert.doesNotMatch(
			db.records[0]?.sql || "",
			/cookie_header|cookie_hash|identity_hash/,
		);
		db.assertBatches([[0, 1, 2, 3]]);
		db.assertDrained();
	});

	test("maps an atomic unique violation to a safe browser conflict", async () => {
		const write = {
			cookieHeader: "secret",
			cookieHash: "hash",
			identityHash: "identity",
			changed: true,
			probe: { statusCode: 1000, issue: null, models: [] },
			nowMs: 8000,
		};
		const db = new RecordingSql([
			{
				sql: /UPDATE gemini_accounts SET cookie_header = \?/,
				binds: [
					"secret",
					"hash",
					"identity",
					8000,
					1000,
					8000,
					8000,
					8000,
					8000,
					"first",
				],
				operation: "batch",
				error: new Error(
					"UNIQUE constraint failed: gemini_accounts.cookie_hash",
				),
			},
			{
				sql: "DELETE FROM gemini_account_models WHERE account_id = ?",
				binds: ["first"],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: /INSERT INTO gemini_browser_accounts/,
				binds: ["first", 8000, 8000, 8000],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(8000, "unconditional"),
		]);
		assert.deepEqual(
			await new SqlGeminiAccountStore(db).replaceVerifiedBrowserCookie(
				"first",
				write,
			),
			{ changed: false, reason: "conflict" },
		);
		db.assertBatches([[0, 1, 2, 3]]);
		db.assertDrained();
	});
	test("reads refresh credentials through the exact secret projection", async () => {
		const db = new RecordingSql([
			{
				sql: "SELECT id, cookie_header, cookie_hash, identity_hash, last_refresh_success_at_ms FROM gemini_accounts WHERE id = ? LIMIT 1",
				binds: ["first"],
				operation: "first",
				result: {
					id: "first",
					cookie_header: "cookie",
					cookie_hash: "cookie-hash",
					identity_hash: "identity-hash",
					last_refresh_success_at_ms: 1234,
				},
			},
		]);
		assert.deepEqual(
			await new SqlGeminiAccountStore(db).getAccountForRefresh("first"),
			{
				id: "first",
				cookie_header: "cookie",
				cookie_hash: "cookie-hash",
				identity_hash: "identity-hash",
				last_refresh_success_at_ms: 1234,
			},
		);
		db.assertDrained();
	});

	test("clamps selectable-account limits and maps snapshot rows", async () => {
		const snapshot = {
			id: "account-a",
			enabled: 1,
			cookie_header: "__Secure-1PSID=p; __Secure-1PSIDTS=t",
			cookie_hash: "cookie-hash",
			issue: null,
			cooldown_until_ms: null,
			last_used_at_ms: 900,
			status_checked_at_ms: 800,
			last_refresh_success_at_ms: 700,
		};
		const db = new RecordingSql([
			{
				sql: /SELECT id, enabled, cookie_header, cookie_hash, issue, .* FROM gemini_accounts .*issue NOT IN \(\?, \?, \?\).*LIMIT \?/,
				binds: [1000, ...durableIssues, 200],
				operation: "all",
				result: { results: [snapshot] },
			},
		]);

		assert.deepEqual(
			await new SqlGeminiAccountStore(db).listSelectableAccounts(1000, 999),
			[snapshot],
		);
		db.assertDrained();
	});

	test("maps refresh-lock changed-row results and records owner-scoped release", async () => {
		const lockSql =
			/INSERT INTO gemini_account_locks .*ON CONFLICT\(account_id\) DO UPDATE SET .*WHERE gemini_account_locks.expires_at_ms <= \?/;
		const db = new RecordingSql([
			{
				sql: lockSql,
				binds: ["first", "owner", 5000, 1000, 1000],
				operation: "run",
				result: mutationResult(1),
			},
			{
				sql: lockSql,
				binds: ["first", "other", 5000, 2000, 2000],
				operation: "run",
				result: mutationResult(0),
			},
			{
				sql: "DELETE FROM gemini_account_locks WHERE account_id = ? AND lock_owner = ?",
				binds: ["first", "owner"],
				operation: "run",
				result: mutationResult(),
			},
		]);
		const store = new SqlGeminiAccountStore(db);

		assert.equal(
			await store.tryAcquireRefreshLock("first", "owner", 5000, 1000),
			true,
		);
		assert.equal(
			await store.tryAcquireRefreshLock("first", "other", 5000, 2000),
			false,
		);
		await store.releaseRefreshLock("first", "owner");
		db.assertDrained();
	});

	test("records refresh timestamps when normalized cookie bytes are unchanged", async () => {
		const cookieHeader = "__Secure-1PSID=p1; __Secure-1PSIDTS=t1";
		const current = accountSqlRow("first", {
			cookie_header: cookieHeader,
			cookie_hash: await sha256Hex(cookieHeader),
		});
		const db = new RecordingSql([
			{
				sql: "SELECT * FROM gemini_accounts WHERE id = ? LIMIT 1",
				binds: ["first"],
				operation: "first",
				result: current,
			},
			{
				sql: /UPDATE gemini_accounts SET last_refresh_at_ms = \?, last_refresh_attempt_at_ms = \?, last_refresh_success_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [2000, 2000, 2000, 2000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(2000),
		]);

		assert.deepEqual(
			await new SqlGeminiAccountStore(db).writeRefreshedCookie("first", {
				cookieHeader,
				refreshedAtMs: 2000,
				nowMs: 2000,
			}),
			{ changed: false },
		);
		db.assertBatches([[1, 2]]);
		db.assertDrained();
	});

	test("binds a changed refreshed cookie after an explicit duplicate lookup", async () => {
		const nextCookie = "__Secure-1PSID=p1; __Secure-1PSIDTS=t1-next";
		const nextHash = await sha256Hex(nextCookie);
		const db = new RecordingSql([
			{
				sql: "SELECT * FROM gemini_accounts WHERE id = ? LIMIT 1",
				binds: ["first"],
				operation: "first",
				result: accountSqlRow("first", { cookie_hash: "old-hash" }),
			},
			{
				sql: "SELECT id FROM gemini_accounts WHERE cookie_hash = ? LIMIT 1",
				binds: [nextHash],
				operation: "first",
				columnName: "id",
				result: null,
			},
			{
				sql: /UPDATE gemini_accounts SET cookie_header = \?, cookie_hash = \?, last_refresh_at_ms = \?, last_refresh_attempt_at_ms = \?, last_refresh_success_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [nextCookie, nextHash, 3000, 3000, 3000, 3000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(3000),
		]);

		assert.deepEqual(
			await new SqlGeminiAccountStore(db).writeRefreshedCookie("first", {
				cookieHeader: nextCookie,
				refreshedAtMs: 3000,
				nowMs: 3000,
			}),
			{ changed: true },
		);
		db.assertBatches([[2, 3]]);
		db.assertDrained();
	});

	test("binds a health-affecting failure and a conditional version increment", async () => {
		const db = new RecordingSql([
			{
				sql: /UPDATE gemini_accounts SET issue = \?, cooldown_until_ms = \?, last_issue_at_ms = \?, last_used_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: ["transient", 9000, 4000, 4000, 4000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(4000),
		]);
		await new SqlGeminiAccountStore(db).writeAccountOutcome("first", {
			kind: "failure",
			issue: "transient",
			cooldownUntilMs: 9000,
			nowMs: 4000,
		});
		db.assertBatches([[0, 1]]);
		db.assertDrained();
	});

	test("records use without changing health for a failure without an issue", async () => {
		const db = new RecordingSql([
			{
				sql: /UPDATE gemini_accounts SET last_used_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [4500, 4500, "first"],
				operation: "run",
				result: mutationResult(),
			},
		]);
		await new SqlGeminiAccountStore(db).writeAccountOutcome("first", {
			kind: "failure",
			nowMs: 4500,
		});
		db.assertDrained();
	});

	test("batches success health clearing before version and last-use recording", async () => {
		const db = new RecordingSql([
			{
				sql: /UPDATE gemini_accounts SET issue = NULL, cooldown_until_ms = NULL, last_issue_at_ms = NULL, updated_at_ms = \? WHERE id = \? AND \(issue IS NOT NULL/,
				binds: [5000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			{
				sql: /UPDATE gemini_accounts SET last_used_at_ms = \?, updated_at_ms = \? WHERE id = \?/,
				binds: [5000, 5000, "first"],
				operation: "batch",
				result: mutationResult(),
			},
			poolVersionExpectation(5000),
		]);
		await new SqlGeminiAccountStore(db).writeAccountOutcome("first", {
			kind: "success",
			nowMs: 5000,
		});
		db.assertBatches([[0, 2, 1]]);
		const versionRecord = db.batches[0]?.[1];
		if (!versionRecord) throw new Error("pool-version batch was not recorded");
		assert.match(versionRecord.sql, /WHERE changes\(\) > 0/);
		db.assertDrained();
	});
});
