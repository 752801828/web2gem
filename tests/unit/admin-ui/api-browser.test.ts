import { describe, test } from "vitest";
import {
	checkBrowserNow,
	clearBrowserCredentials,
	configureBrowserCredentials,
	deleteAccountBrowserProfile,
	getAccountCookie,
	openAccountBrowser,
	stopAccountBrowser,
	updateAccountCookie,
} from "../../../src/admin-ui/api";
import { assert } from "../assertions.js";
import { withAdminFetch } from "./_support/environment.js";
import {
	type RecordedRequest,
	recordedRequest,
	requestBody,
	requestHeaders,
	requiredValue,
	uiAdminApiSession,
} from "./_support/fixtures.js";

const STATUS = {
	credentialsConfigured: true,
	status: {
		state: "ready",
		lastCheckAtMs: 10,
		lastCookieUpdateAtMs: 11,
		lastAutoLoginAtMs: 12,
		failureCode: null,
	},
} as const;

describe("admin UI browser API", () => {
	test("sends exact methods, paths, bodies, authorization, and abort signals", async () => {
		const requests: RecordedRequest[] = [];
		const session = uiAdminApiSession();
		await withAdminFetch(
			async (path: RequestInfo | URL, init: RequestInit = {}) => {
				requests.push(recordedRequest(path, init));
				if (String(path).endsWith("/open"))
					return Response.json({ url: "http://127.0.0.1:6080/vnc.html" });
				if (String(path) === "/admin/browser/stop")
					return Response.json({ stopped: true });
				if (String(path).endsWith("/profile"))
					return Response.json({ deleted: true });
				return Response.json(STATUS);
			},
			async () => {
				await configureBrowserCredentials(session, "account/a", {
					email: "owner@example.com",
					password: "password",
					totpSecret: "JBSWY3DPEHPK3PXP",
				});
				await clearBrowserCredentials(session, "account/a");
				await checkBrowserNow(session, "account/a");
				await openAccountBrowser(session, "account/a");
				await stopAccountBrowser(session);
				await deleteAccountBrowserProfile(session, "account/a");
			},
		);

		assert.deepEqual(
			requests.map(({ path, init }) => [path, init.method]),
			[
				["/admin/accounts/account%2Fa/browser/credentials", "PUT"],
				["/admin/accounts/account%2Fa/browser/credentials", "DELETE"],
				["/admin/accounts/account%2Fa/browser/check", "POST"],
				["/admin/accounts/account%2Fa/browser/open", "POST"],
				["/admin/browser/stop", "POST"],
				["/admin/accounts/account%2Fa/browser/profile", "DELETE"],
			],
		);
		assert.deepEqual(JSON.parse(requestBody(requiredValue(requests[0]).init)), {
			email: "owner@example.com",
			password: "password",
			totpSecret: "JBSWY3DPEHPK3PXP",
		});
		assert.equal(Object.hasOwn(requiredValue(requests[1]).init, "body"), false);
		assert.equal(Object.hasOwn(requiredValue(requests[2]).init, "body"), false);
		assert.equal(Object.hasOwn(requiredValue(requests[3]).init, "body"), false);
		assert.equal(Object.hasOwn(requiredValue(requests[4]).init, "body"), false);
		assert.deepEqual(JSON.parse(requestBody(requiredValue(requests[5]).init)), {
			confirmAccountId: "account/a",
		});
		assert.equal(
			requests.every(
				({ init }) =>
					init.signal === session.signal &&
					requestHeaders(init).get("Authorization") === "Bearer admin-secret",
			),
			true,
		);
	});

	test("rejects unsafe browser response fields", async () => {
		await withAdminFetch(
			async () =>
				Response.json({
					...STATUS,
					credentialCiphertext: "must-not-reach-ui",
				}),
			async () => {
				await assert.rejects(
					configureBrowserCredentials(uiAdminApiSession(), "account-a", {
						email: "owner@example.com",
						password: "password",
						totpSecret: "JBSWY3DPEHPK3PXP",
					}),
					/admin browser status response is invalid/,
				);
			},
		);
	});

	test("loads and updates only the two CK values", async () => {
		const requests: RecordedRequest[] = [];
		await withAdminFetch(
			async (path: RequestInfo | URL, init: RequestInit = {}) => {
				requests.push(recordedRequest(path, init));
				if (init.method === "GET")
					return Response.json({
						"__Secure-1PSID": "current-psid",
						"__Secure-1PSIDTS": "current-psidts",
					});
				return Response.json({
					processed: 1,
					changed: 1,
					unchanged: 0,
					failed: 0,
				});
			},
			async () => {
				assert.deepEqual(
					await getAccountCookie(uiAdminApiSession(), "account/a"),
					{ psid: "current-psid", psidts: "current-psidts" },
				);
				await updateAccountCookie(uiAdminApiSession(), "account/a", {
					psid: "new-psid",
					psidts: "new-psidts",
				});
			},
		);
		assert.deepEqual(
			requests.map(({ path, init }) => [path, init.method]),
			[
				["/admin/accounts/account%2Fa/cookie", "GET"],
				["/admin/accounts/account%2Fa/cookie", "PUT"],
			],
		);
		const request = requiredValue(requests[1]);
		assert.deepEqual(
			[request.path, request.init.method],
			["/admin/accounts/account%2Fa/cookie", "PUT"],
		);
		assert.deepEqual(JSON.parse(requestBody(request.init)), {
			"__Secure-1PSID": "new-psid",
			"__Secure-1PSIDTS": "new-psidts",
		});
	});

	test("rejects extra fields in a CK read response", async () => {
		await withAdminFetch(
			async () =>
				Response.json({
					"__Secure-1PSID": "p",
					"__Secure-1PSIDTS": "t",
					cookieHeader: "must-not-reach-ui",
				}),
			async () => {
				await assert.rejects(
					getAccountCookie(uiAdminApiSession(), "account-a"),
					/account CK response is invalid/,
				);
			},
		);
	});
});
