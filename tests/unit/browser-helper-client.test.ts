import { describe, test } from "vitest";
import { createBrowserHelperClient } from "../../server/browser-helper-client.mjs";
import { assert } from "./assertions.js";

const ENV = {
	BROWSER_HELPER_INTERNAL_URL: "http://browser-helper:6090",
	BROWSER_HELPER_INTERNAL_TOKEN: "internal-token",
	NOVNC_PUBLIC_URL: "http://127.0.0.1:6080/vnc.html",
};

describe("Docker browser-helper control client", () => {
	test("uses the control token and exact helper paths", async () => {
		const requests: Array<{
			url: string;
			method: string;
			auth: string | null;
			redirect: RequestRedirect | undefined;
		}> = [];
		const client = createBrowserHelperClient(ENV, {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				const headers = new Headers(init?.headers);
				requests.push({
					url: String(input),
					method: init?.method || "GET",
					auth: headers.get("authorization"),
					redirect: init?.redirect,
				});
				return Response.json({ ignored: "private" });
			},
		});
		if (!client) throw new Error("expected browser helper client");
		await client.checkNow("account a");
		assert.deepEqual(await client.openVisible("account a"), {
			url: ENV.NOVNC_PUBLIC_URL,
		});
		await client.stopVisible();
		await client.deleteProfile("account a");
		assert.deepEqual(requests, [
			{
				url: "http://browser-helper:6090/checks/account%20a",
				method: "POST",
				auth: "Bearer internal-token",
				redirect: "error",
			},
			{
				url: "http://browser-helper:6090/sessions/account%20a/open",
				method: "POST",
				auth: "Bearer internal-token",
				redirect: "error",
			},
			{
				url: "http://browser-helper:6090/sessions/stop",
				method: "POST",
				auth: "Bearer internal-token",
				redirect: "error",
			},
			{
				url: "http://browser-helper:6090/profiles/account%20a",
				method: "DELETE",
				auth: "Bearer internal-token",
				redirect: "error",
			},
		]);
	});

	test("maps connection failures to a fixed safe error", async () => {
		const client = createBrowserHelperClient(ENV, {
			async fetch() {
				throw new Error("connect ECONNREFUSED token=secret");
			},
		});
		if (!client) throw new Error("expected browser helper client");
		let error: unknown;
		try {
			await client.checkNow("account-a");
		} catch (caught) {
			error = caught;
		}
		assert.equal(
			(error as { code?: unknown }).code,
			"browser_helper_unavailable",
		);
		assert.doesNotMatch(String(error), /ECONNREFUSED|secret|token/i);
	});

	test("maps response-stream failures to a fixed safe error", async () => {
		const client = createBrowserHelperClient(ENV, {
			async fetch() {
				return new Response(
					new ReadableStream({
						pull(controller) {
							controller.error(new Error("stream disconnected token=secret"));
						},
					}),
				);
			},
		});
		if (!client) throw new Error("expected browser helper client");
		let error: unknown;
		try {
			await client.checkNow("account-a");
		} catch (caught) {
			error = caught;
		}
		assert.equal(
			(error as { code?: unknown }).code,
			"browser_helper_unavailable",
		);
		assert.doesNotMatch(String(error), /disconnected|secret|token/i);
	});

	test("rejects helper responses larger than 64 KiB", async () => {
		const client = createBrowserHelperClient(ENV, {
			async fetch() {
				return new Response("x".repeat(65 * 1024));
			},
		});
		if (!client) throw new Error("expected browser helper client");
		let error: unknown;
		try {
			await client.checkNow("account-a");
		} catch (caught) {
			error = caught;
		}
		assert.equal(
			(error as { code?: unknown }).code,
			"browser_helper_response_too_large",
		);
	});

	test("preserves safe helper error codes without forwarding remote details", async () => {
		const client = createBrowserHelperClient(ENV, {
			async fetch() {
				return Response.json(
					{
						error: {
							code: "visible_session_conflict",
							message: "token=private session detail",
						},
					},
					{ status: 409 },
				);
			},
		});
		if (!client) throw new Error("expected browser helper client");
		let error: unknown;
		try {
			await client.openVisible("account-a");
		} catch (caught) {
			error = caught;
		}
		assert.equal(
			(error as { code?: unknown }).code,
			"visible_session_conflict",
		);
		assert.doesNotMatch(String(error), /private|session detail|token/i);
	});

	test("uses a separate bounded open timeout and propagates caller cancellation", async () => {
		const timeouts: number[] = [];
		const caller = new AbortController();
		let observedSignal: AbortSignal | undefined;
		const client = createBrowserHelperClient(ENV, {
			timeoutMs: 15_000,
			openTimeoutMs: 60_000,
			timeoutSignal(milliseconds: number) {
				timeouts.push(milliseconds);
				return new AbortController().signal;
			},
			async fetch(_input: RequestInfo | URL, init?: RequestInit) {
				observedSignal = init?.signal || undefined;
				return new Promise<Response>((_resolve, reject) =>
					observedSignal?.addEventListener(
						"abort",
						() => reject(new Error("private abort detail")),
						{ once: true },
					),
				);
			},
		});
		if (!client) throw new Error("expected browser helper client");
		const opening = client.openVisible("account-a", caller.signal);
		caller.abort();
		await assert.rejects(opening, /browser helper is unavailable/);
		assert.deepEqual(timeouts, [60_000]);
		assert.equal(observedSignal?.aborted, true);
	});

	test("rejects public noVNC URLs containing credentials or tokens", () => {
		for (const url of [
			"http://user:password@127.0.0.1:6080/vnc.html",
			"http://127.0.0.1:6080/vnc.html?token=private",
			"https://remote.example/vnc.html",
		]) {
			assert.throws(
				() => createBrowserHelperClient({ ...ENV, NOVNC_PUBLIC_URL: url }),
				/invalid browser helper configuration/i,
			);
		}
	});

	test("rejects internal URLs outside the Compose browser-helper host", () => {
		for (const url of [
			"http://external.example:6090",
			"http://127.0.0.1:6090",
		]) {
			assert.throws(
				() =>
					createBrowserHelperClient({
						...ENV,
						BROWSER_HELPER_INTERNAL_URL: url,
					}),
				/invalid browser helper configuration/i,
			);
		}
	});

	test("returns null when helper configuration is entirely absent", () => {
		assert.equal(createBrowserHelperClient({}), null);
	});
});
