import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/main.mjs";
const { createBrowserHelperProcess } = await import(modulePath);

describe("browser helper process composition", () => {
	test("starts scheduler before HTTP and shuts down in the required safe order", async () => {
		const calls: string[] = [];
		const processLifecycle = createBrowserHelperProcess(
			{
				internalToken: "test-internal-token",
				novncPassword: "test-novnc-password",
				visibleIdleTimeoutSec: 60,
			},
			new Uint8Array(32),
			{
				env: {},
				createClient: () => ({}),
				createBrowser: () => ({
					async close() {
						calls.push("chromium-stop");
					},
				}),
				createNoVnc: () => ({
					async stop() {
						calls.push("novnc-stop");
					},
				}),
				createSessions: () => ({
					hold: async () => undefined,
					isActive: () => false,
					requestStop() {
						calls.push("visible-stop-request");
					},
				}),
				createNotifier: () => ({}),
				createScheduler: () => ({
					async start() {
						calls.push("scheduler-start");
					},
					async stop() {
						calls.push("scheduler-stop");
					},
					isBusy: () => false,
				}),
				createProfiles: () => ({}),
				createServer: () => ({
					async start() {
						calls.push("http-start");
					},
					async stop() {
						calls.push("http-stop");
					},
				}),
			},
		);
		await processLifecycle.start();
		await processLifecycle.stop();
		assert.deepEqual(calls, [
			"scheduler-start",
			"http-start",
			"http-stop",
			"visible-stop-request",
			"scheduler-stop",
			"chromium-stop",
			"novnc-stop",
		]);
	});

	test("rejects a missing master key without exposing configuration", () => {
		assert.throws(
			() => createBrowserHelperProcess({}, null),
			/browser helper master key is unavailable/,
		);
	});
});
