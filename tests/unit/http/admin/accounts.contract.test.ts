import { describe, test } from "vitest";
import {
	createRuntimeConfig,
	getConfig,
	type AppEnv,
} from "../../../../src/config";
import { handleGeminiAccountAdminRequest } from "../../../../src/http/admin/gemini-accounts";
import { isRecord } from "../../../../src/shared/types";
import { assert } from "../../assertions.js";

const cfg = createRuntimeConfig(getConfig({ ADMIN_KEY: "admin-secret" }));

function failOnSql() {
	return {
		prepare(sql: string) {
			throw new Error(`unexpected SQL access: ${sql}`);
		},
	};
}

function request(path: string, init: RequestInit = {}, env: AppEnv = {}) {
	const url = new URL(`https://worker.example${path}`);
	return handleGeminiAccountAdminRequest(
		new Request(url, {
			...init,
			headers: {
				Authorization: "Bearer admin-secret",
				...(init.headers || {}),
			},
		}),
		env,
		cfg,
		url,
	);
}

function errorCode(value: unknown): unknown {
	if (!isRecord(value) || !isRecord(value.error))
		throw new Error("expected error body");
	return value.error.code;
}

describe("Gemini account admin HTTP contract", () => {
	test("rejects an unauthorized request before SQL access", async () => {
		const url = new URL("https://worker.example/admin/accounts");
		const response = await handleGeminiAccountAdminRequest(
			new Request(url),
			{ ACCOUNT_DB: failOnSql() },
			cfg,
			url,
		);
		assert.equal(response.status, 401);
		assert.equal(errorCode(await response.json()), "invalid_admin_key");
	});

	test("returns 404 for retired stats and account-check routes without SQL access", async () => {
		for (const path of ["/admin/accounts/stats", "/admin/accounts/a/check"]) {
			const response = await request(path, {}, { ACCOUNT_DB: failOnSql() });
			assert.equal(response.status, 404);
			assert.equal(errorCode(await response.json()), "admin_route_not_found");
		}
	});

	test("returns a sanitized legacy-query error before SQL access", async () => {
		const response = await request(
			"/admin/accounts?status=active",
			{},
			{ ACCOUNT_DB: failOnSql() },
		);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			error: {
				code: "unknown_admin_query_parameter",
				message: "unknown admin query parameter: status",
			},
		});
	});

	test("recognizes list and create routes before reporting a missing store", async () => {
		const list = await request("/admin/accounts");
		assert.equal(list.status, 503);
		assert.equal(
			errorCode(await list.json()),
			"gemini_account_store_unavailable",
		);

		const create = await request("/admin/accounts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				"__Secure-1PSID": "p",
				"__Secure-1PSIDTS": "t",
			}),
		});
		assert.equal(create.status, 503);
		assert.equal(
			errorCode(await create.json()),
			"gemini_account_store_unavailable",
		);
	});

	test("recognizes bulk-action routing before reporting a missing store", async () => {
		const response = await request("/admin/accounts/actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "enable", ids: ["a"] }),
		});
		assert.equal(response.status, 503);
		assert.equal(
			errorCode(await response.json()),
			"gemini_account_store_unavailable",
		);
	});

	test("recognizes update, cookie, delete, and refresh resource commands", async () => {
		const cases = [
			[
				"/admin/accounts/a",
				{
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ label: "A" }),
				},
			],
			["/admin/accounts/a/cookie", { method: "GET" }],
			[
				"/admin/accounts/a/cookie",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						"__Secure-1PSID": "p",
						"__Secure-1PSIDTS": "t",
					}),
				},
			],
			["/admin/accounts/a", { method: "DELETE" }],
			["/admin/accounts/a/refresh", { method: "POST" }],
		] satisfies readonly (readonly [string, RequestInit])[];
		for (const [path, init] of cases) {
			const response = await request(path, init);
			assert.equal(response.status, 503);
			assert.equal(
				errorCode(await response.json()),
				"gemini_account_store_unavailable",
			);
		}
	});

	test("rejects malformed JSON before SQL access", async () => {
		const response = await request(
			"/admin/accounts",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			},
			{ ACCOUNT_DB: failOnSql() },
		);
		assert.equal(response.status, 400);
		assert.equal(errorCode(await response.json()), "invalid_admin_json");
	});

	test("rejects a delete body and an unknown resource action before SQL access", async () => {
		const deleteBody = await request(
			"/admin/accounts/a",
			{ method: "DELETE", body: "unexpected" },
			{ ACCOUNT_DB: failOnSql() },
		);
		assert.equal(deleteBody.status, 400);
		assert.equal(
			errorCode(await deleteBody.json()),
			"admin_request_body_not_allowed",
		);

		const unknown = await request(
			"/admin/accounts/a/unknown",
			{ method: "POST" },
			{ ACCOUNT_DB: failOnSql() },
		);
		assert.equal(unknown.status, 404);
		assert.equal(errorCode(await unknown.json()), "admin_route_not_found");
	});
});
