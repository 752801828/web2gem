import { describe, test } from "vitest";
import {
	SqlGeminiAccountStore,
	summaryFromSql,
} from "../../../../src/gemini/accounts/store-sql";
import { assert } from "../../assertions.js";
import {
	adminSqlRow,
	durableIssues,
	RecordingSql,
} from "./_support/store-fixtures.js";

describe("SQL Gemini account store admin projections", () => {
	test("normalizes malformed browser status from SQL rows", () => {
		const row = adminSqlRow("account-a");
		const malformed = {
			...row,
			credentials_configured: 0,
			credential_version: 1,
			browser_state: "not-a-browser-state",
			failure_code: 42,
		};

		assert.deepEqual(summaryFromSql(malformed, 1000).browser, {
			credentialsConfigured: false,
			state: "idle",
			lastCheckAtMs: null,
			lastCookieUpdateAtMs: null,
			lastAutoLoginAtMs: null,
			failureCode: null,
		});
	});

	test("maps a filtered admin overview without selecting credential columns", async () => {
		const row = adminSqlRow("account-a", {
			label: "Alpha",
			issue: "rate_limit",
			cooldown_until_ms: 5000,
			credentials_configured: 0,
			browser_state: "idle",
			last_check_at_ms: null,
			last_cookie_update_at_ms: null,
			last_auto_login_at_ms: null,
			failure_code: null,
		});
		const stats = {
			total: 1,
			available: 0,
			cooling: 1,
			attention: 0,
			disabled: 0,
		};
		const db = new RecordingSql([
			{
				sql: /SELECT a\.id, a\.label, a\.enabled, a\.issue, a\.cooldown_until_ms, .* COALESCE\(b\.credential_ciphertext IS NOT NULL AND b\.credential_nonce IS NOT NULL AND b\.credential_version = 1 AND b\.login_email_hash IS NOT NULL, 0\) AS credentials_configured, .* FROM gemini_accounts a LEFT JOIN gemini_browser_accounts b ON b\.account_id = a\.id WHERE a\.enabled = 1 AND a\.cooldown_until_ms > \? ORDER BY a\.id ASC LIMIT \?/,
				binds: [1000, 11],
				operation: "batch",
				result: { results: [row] },
			},
			{
				sql: /SELECT COUNT\(\*\) AS total, .* FROM gemini_accounts/,
				binds: [1000, ...durableIssues, 1000, 1000, ...durableIssues],
				operation: "batch",
				result: { results: [stats] },
			},
		]);

		const overview = await new SqlGeminiAccountStore(db).getAdminOverview(
			{ limit: 10, state: "cooling" },
			1000,
		);
		assert.deepEqual(overview.stats, stats);
		const item = overview.items[0];
		if (!item) throw new Error("admin overview did not return an item");
		assert.equal(item.state, "cooling");
		assert.equal(item.issue, "rate_limit");
		assert.deepEqual(item.browser, {
			credentialsConfigured: false,
			state: "idle",
			lastCheckAtMs: null,
			lastCookieUpdateAtMs: null,
			lastAutoLoginAtMs: null,
			failureCode: null,
		});
		assert.equal(Object.keys(item).length, 14);
		const pageRecord = db.records[0];
		if (!pageRecord) throw new Error("admin page statement was not recorded");
		assert.doesNotMatch(
			pageRecord.sql,
			/cookie_header|cookie_hash|identity_hash|b\.(?:credential_ciphertext|credential_nonce|login_email_hash)\s*(?:,|\bAS\b)/i,
		);
		assert.doesNotMatch(
			pageRecord.sql,
			/b\.(?:credential_ciphertext|credential_nonce|login_email_hash)\s+(?!IS\b)[A-Za-z_]\w*/i,
		);
		assert.doesNotMatch(
			JSON.stringify(overview),
			/secret|cookie_hash|ciphertext|nonce|email_hash|token/,
		);
		db.assertBatches([[0, 1]]);
		db.assertDrained();
	});
});
