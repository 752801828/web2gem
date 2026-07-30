import { describe, test } from "vitest";
import { httpFetch } from "../../../../src/gemini/transport/http";
import { assert } from "../../assertions.js";
import { withFetch } from "../../_support/globals.js";

describe("httpFetch", () => {
	test("uses native fetch with linked caller and timeout signals", async () => {
		const originalDescriptor = Object.getOwnPropertyDescriptor(
			AbortSignal,
			"any",
		);
		const originalAny = originalDescriptor?.value;
		if (typeof originalAny !== "function")
			throw new Error("expected AbortSignal.any");
		let calls = 0;
		Object.defineProperty(AbortSignal, "any", {
			...originalDescriptor,
			value(signals: AbortSignal[]) {
				calls += 1;
				return originalAny.call(AbortSignal, signals);
			},
		});
		try {
			const controller = new AbortController();
			await withFetch(
				async (_url: RequestInfo | URL, init: RequestInit = {}) => {
					assert.equal(init.signal instanceof AbortSignal, true);
					return new Response("ok", { status: 202 });
				},
				async () => {
					const response = await httpFetch("https://example.test/native", {
						timeoutMs: 1000,
						signal: controller.signal,
					});
					assert.equal(response.status, 202);
					assert.equal(await response.text(), "ok");
				},
			);
			assert.equal(calls, 1);
		} finally {
			if (originalDescriptor)
				Object.defineProperty(AbortSignal, "any", originalDescriptor);
			else Reflect.deleteProperty(AbortSignal, "any");
		}
	});

	test("passes method headers and body through standard fetch", async () => {
		await withFetch(
			async (_url: RequestInfo | URL, init: RequestInit = {}) => {
				assert.equal(init.method, "POST");
				assert.deepEqual(init.headers, { "content-type": "text/plain" });
				assert.equal(await new Response(init.body).text(), "payload");
				return new Response("accepted");
			},
			async () => {
				const response = await httpFetch("https://example.test/post", {
					method: "POST",
					headers: { "content-type": "text/plain" },
					body: "payload",
				});
				assert.equal(await response.text(), "accepted");
			},
		);
	});

	test("passes streaming request bodies with Node duplex mode", async () => {
		await withFetch(
			async (_url: RequestInfo | URL, init: RequestInit = {}) => {
				assert.equal(
					(init as RequestInit & { duplex?: string }).duplex,
					"half",
				);
				assert.equal(await new Response(init.body).text(), "streamed");
				return new Response("ok");
			},
			async () => {
				await httpFetch("https://example.test/stream", {
					method: "POST",
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("streamed"));
							controller.close();
						},
					}),
				});
			},
		);
	});
});
