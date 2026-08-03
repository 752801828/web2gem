import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/main.mjs";
const { createBrowserHelperProcess } = await import(modulePath);

describe("browser helper process composition", () => {
	test("uses sanitized HTTP proxy settings for Chromium", () => {
		for (const [key, proxyUrl] of [
			["HTTPS_PROXY", "http://proxy-user:proxy-pass@proxy.test:8443"],
			["HTTP_PROXY", "http://proxy-user:proxy-pass@proxy.test:8080"],
		] as const) {
			let browserOptions: Record<string, unknown> | undefined;
			let sessionDependencies: Record<string, unknown> | undefined;
			createBrowserHelperProcess(
				{
					internalToken: "test-internal-token",
					novncPassword: "test-novnc-password",
					visibleIdleTimeoutSec: 60,
				},
				new Uint8Array(32),
				{
					env: {
						[key]: proxyUrl,
						BROWSER_HELPER_INTERNAL_TOKEN: "must-not-enter-proxy",
						NOVNC_PASSWORD: "must-not-enter-proxy",
					},
					createClient: () => ({}),
					createBrowser: (options: Record<string, unknown>) => {
						browserOptions = options;
						return { close: async () => undefined };
					},
					createNoVnc: () => ({ stop: async () => undefined }),
					createSessions: (
						_config: unknown,
						dependencies: Record<string, unknown>,
					) => {
						sessionDependencies = dependencies;
						return {
							hold: async () => undefined,
							isActive: () => false,
							requestStop: () => undefined,
						};
					},
					createNotifier: () => ({}),
					createScheduler: () => ({
						start: async () => undefined,
						stop: async () => undefined,
						reserve: () => () => undefined,
					}),
					createProfiles: () => ({}),
					createServer: () => ({
						start: async () => undefined,
						beginStop: () => undefined,
						drain: async () => undefined,
					}),
				},
			);
			assert.deepEqual(browserOptions?.proxy, {
				server:
					key === "HTTPS_PROXY"
						? "http://proxy.test:8443"
						: "http://proxy.test:8080",
				username: "proxy-user",
				password: "proxy-pass",
			});
			assert.doesNotMatch(
				JSON.stringify(browserOptions?.proxy),
				/must-not-enter-proxy/,
			);
			assert.equal(
				typeof sessionDependencies?.waitForAuthentication,
				"function",
			);
		}
	});

	test("rejects socks5 URLs from HTTP proxy variables without exposing credentials", () => {
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY"] as const) {
			let caught: unknown;
			try {
				createBrowserHelperProcess(
					{
						internalToken: "test-internal-token",
						novncPassword: "test-novnc-password",
						visibleIdleTimeoutSec: 60,
					},
					new Uint8Array(32),
					{
						env: {
							[key]: "socks5://private-user:private-pass@proxy.test:1080",
						},
						createClient: () => ({}),
					},
				);
			} catch (error) {
				caught = error;
			}
			assert.equal(caught instanceof Error, true);
			const message = caught instanceof Error ? caught.message : String(caught);
			assert.equal(message, "invalid browser helper proxy configuration");
			assert.doesNotMatch(message, /private-user|private-pass|proxy\.test/);
		}
	});

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
					beginStop() {
						calls.push("http-begin-stop");
					},
					async drain() {
						calls.push("http-drain");
					},
				}),
			},
		);
		await processLifecycle.start();
		await processLifecycle.stop();
		assert.deepEqual(calls, [
			"scheduler-start",
			"http-start",
			"http-begin-stop",
			"visible-stop-request",
			"scheduler-stop",
			"chromium-stop",
			"novnc-stop",
			"http-drain",
		]);
	});

	test("does not deadlock shutdown on a stuck HTTP request", async () => {
		const calls: string[] = [];
		let releaseDrain!: () => void;
		const draining = new Promise<void>((resolve) => {
			releaseDrain = resolve;
		});
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
				createBrowser: () => ({ close: async () => calls.push("chromium") }),
				createNoVnc: () => ({ stop: async () => calls.push("novnc") }),
				createSessions: () => ({
					hold: async () => undefined,
					isActive: () => false,
					requestStop: () => calls.push("session"),
				}),
				createNotifier: () => ({}),
				createScheduler: () => ({
					start: async () => undefined,
					stop: async () => calls.push("scheduler"),
					reserve: () => () => undefined,
				}),
				createProfiles: () => ({}),
				createServer: () => ({
					start: async () => undefined,
					beginStop: () => calls.push("http-begin"),
					async drain() {
						calls.push("http-drain");
						await draining;
					},
				}),
			},
		);
		await processLifecycle.start();
		let finished = false;
		const stopping = processLifecycle.stop().then(() => {
			finished = true;
		});
		for (let index = 0; index < 10 && calls.length < 6; index += 1)
			await Promise.resolve();
		assert.deepEqual(calls, [
			"http-begin",
			"session",
			"scheduler",
			"chromium",
			"novnc",
			"http-drain",
		]);
		assert.equal(finished, false);
		releaseDrain();
		await stopping;
	});

	test("rejects a missing master key without exposing configuration", () => {
		assert.throws(
			() => createBrowserHelperProcess({}, null),
			/browser helper master key is unavailable/,
		);
	});
});
