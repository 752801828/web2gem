import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const clientModulePath: string = "../../../browser-helper/web2gem-client.mjs";
const { createWeb2gemClient } = await import(clientModulePath);

const CONFIG = {
	web2gemInternalUrl: "http://web2gem:52389/",
	internalToken: "test-internal-token",
};

describe("private web2gem client", () => {
	test("uses Bearer auth, exact routes, JSON bodies, timeouts, and no redirects", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const responses = [
			{ accounts: [] },
			{ acquired: true },
			{ released: true },
			{
				version: 1,
				ciphertext: "YWFhYWFhYWFhYWFhYWFhYQ==",
				nonce: "YWFhYWFhYWFhYWFh",
				emailHash: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=",
			},
			{ updated: true },
			{ changed: false, state: "ready", lastCookieUpdateAtMs: 123 },
		];
		const client = createWeb2gemClient(CONFIG, {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				requests.push({ url: String(input), init: init || {} });
				return Response.json(responses.shift(), {
					headers: { Date: new Date(60_000).toUTCString() },
				});
			},
		});
		await client.listAccounts();
		assert.equal(await client.acquireLease("account a", "owner", 30), true);
		await client.releaseLease("account a", "owner");
		await client.getEncryptedCredentials("account a");
		await client.patchState("account a", {
			state: "ready",
			lastCheckAtMs: 1,
			lastCookieUpdateAtMs: 2,
			lastAutoLoginAtMs: null,
			authFailureCount: 0,
			notificationState: null,
			failureCode: null,
		});
		await client.submitCandidateCookie("account a", {
			psid: "test-psid",
			psidts: "test-psidts",
			observedEmail: "owner@example.com",
		});

		assert.deepEqual(
			requests.map(({ url, init }) => [
				url,
				init.method || "GET",
				new Headers(init.headers).get("authorization"),
				init.redirect,
				Boolean(init.signal),
			]),
			[
				[
					"http://web2gem:52389/internal/browser/accounts",
					"GET",
					"Bearer test-internal-token",
					"error",
					true,
				],
				[
					"http://web2gem:52389/internal/browser/accounts/account%20a/lease",
					"POST",
					"Bearer test-internal-token",
					"error",
					true,
				],
				[
					"http://web2gem:52389/internal/browser/accounts/account%20a/lease",
					"DELETE",
					"Bearer test-internal-token",
					"error",
					true,
				],
				[
					"http://web2gem:52389/internal/browser/accounts/account%20a/credentials",
					"GET",
					"Bearer test-internal-token",
					"error",
					true,
				],
				[
					"http://web2gem:52389/internal/browser/accounts/account%20a/state",
					"PATCH",
					"Bearer test-internal-token",
					"error",
					true,
				],
				[
					"http://web2gem:52389/internal/browser/accounts/account%20a/candidate-cookie",
					"POST",
					"Bearer test-internal-token",
					"error",
					true,
				],
			],
		);
		assert.equal(client.serverDate, new Date(60_000).toUTCString());
	});

	test("caps JSON responses and throws only safe local errors", async () => {
		const privateValue = "do-not-echo-private-value";
		for (const response of [
			new Response(privateValue, {
				status: 500,
				headers: { "content-type": "text/plain" },
			}),
			Response.json(
				{ error: { code: "unsafe_remote_code", message: privateValue } },
				{ status: 500 },
			),
			new Response("x".repeat(65 * 1024), {
				headers: { "content-type": "application/json" },
			}),
		]) {
			const client = createWeb2gemClient(CONFIG, {
				async fetch() {
					return response;
				},
			});
			let error: unknown;
			try {
				await client.listAccounts();
			} catch (caught) {
				error = caught;
			}
			assert.match(
				String((error as { code?: unknown }).code),
				/^web2gem_(?:request_failed|invalid_response|response_too_large)$/,
			);
			assert.doesNotMatch(String(error), new RegExp(privateValue));
			assert.doesNotMatch(
				String(error),
				/authorization|Bearer|internal-token/i,
			);
		}

		const client = createWeb2gemClient(CONFIG, {
			async fetch() {
				throw new Error(`connect failed ${privateValue}`);
			},
		});
		await assert.rejects(client.listAccounts(), /web2gem is unavailable/);
	});
});
