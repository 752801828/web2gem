import { createHash } from "node:crypto";
import path from "node:path";
import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/chromium.mjs";
const { createChromiumLifecycle, profilePathForAccount } = await import(
	modulePath
);

describe("browser helper Chromium lifecycle", () => {
	test("derives an opaque profile directory beneath the configured root", () => {
		const root = path.resolve("profile-fixture");
		const accountId = "../../other-profile";
		const expected = createHash("sha256").update(accountId).digest("hex");
		const profilePath = profilePathForAccount(accountId, root);

		assert.equal(profilePath, path.join(root, expected));
		assert.equal(path.dirname(profilePath), root);
		assert.throws(
			() => profilePathForAccount("", root),
			/browser account id is invalid/,
		);
	});

	test("launches one injected persistent context with safe container options", async () => {
		const launches: Array<[string, Record<string, unknown>]> = [];
		let closed = 0;
		const context = {
			cookies: async (origin: string) => [{ name: "origin", value: origin }],
			close: async () => {
				closed += 1;
			},
		};
		const lifecycle = createChromiumLifecycle({
			browserType: {
				launchPersistentContext: async (
					profilePath: string,
					options: Record<string, unknown>,
				) => {
					launches.push([profilePath, options]);
					return context;
				},
			},
			profilesRoot: path.resolve("profiles"),
			proxy: { server: "http://proxy.invalid:7897" },
			env: {
				PATH: "/usr/bin",
				LANG: "C.UTF-8",
				NOVNC_PASSWORD: "must-not-reach-browser",
				BROWSER_HELPER_INTERNAL_TOKEN: "must-not-reach-browser",
			},
		});

		assert.equal(await lifecycle.startHeadless("account-a"), context);
		assert.equal(launches.length, 1);
		assert.equal(launches[0]?.[1].executablePath, "/usr/bin/chromium");
		assert.equal(launches[0]?.[1].headless, true);
		assert.deepEqual(launches[0]?.[1].ignoreDefaultArgs, [
			"--enable-automation",
		]);
		assert.deepEqual(launches[0]?.[1].proxy, {
			server: "http://proxy.invalid:7897",
		});
		assert.deepEqual(launches[0]?.[1].env, {
			PATH: "/usr/bin",
			LANG: "C.UTF-8",
			DISPLAY: ":99",
		});
		const args = launches[0]?.[1].args as string[];
		assert.equal(args.includes("--no-first-run"), true);
		assert.equal(args.includes("--disable-dev-shm-usage"), true);
		assert.equal(args.includes("--no-sandbox"), true);
		assert.equal(
			args.includes("--disable-blink-features=AutomationControlled"),
			true,
		);
		assert.equal(
			args.some((arg) => arg.includes("disable-web-security")),
			false,
		);
		assert.deepEqual(await lifecycle.cookies(), [
			{ name: "origin", value: "https://gemini.google.com" },
		]);

		await assert.rejects(
			lifecycle.startVisible("account-b"),
			/browser context is already active/,
		);
		await lifecycle.close();
		assert.equal(closed, 1);
		assert.equal((await lifecycle.startVisible("account-b")) === context, true);
		assert.equal(launches[1]?.[1].headless, false);
		await lifecycle.close();
	});

	test("removes Chromium singleton artifacts left by an older container", async () => {
		const removed: string[] = [];
		const events: string[] = [];
		const lifecycle = createChromiumLifecycle({
			browserType: {
				launchPersistentContext: async () => {
					events.push("launch");
					return { cookies: async () => [], close: async () => undefined };
				},
			},
			currentHostname: "new-container",
			readlink: async () => "old-container-1454",
			unlink: async (target: string) => {
				removed.push(path.basename(target));
				events.push("unlink");
			},
		});

		await lifecycle.startHeadless("account-a");
		assert.deepEqual(removed.sort(), [
			"SingletonCookie",
			"SingletonLock",
			"SingletonSocket",
		]);
		assert.equal(events.at(-1), "launch");
		await lifecycle.close();
	});

	test("keeps a live Chromium singleton owned by this container", async () => {
		let unlinks = 0;
		const lifecycle = createChromiumLifecycle({
			browserType: {
				launchPersistentContext: async () => ({
					cookies: async () => [],
					close: async () => undefined,
				}),
			},
			currentHostname: "current-container",
			readlink: async () => "current-container-42",
			processAlive: () => true,
			unlink: async () => {
				unlinks += 1;
			},
		});

		await lifecycle.startVisible("account-a");
		assert.equal(unlinks, 0);
		await lifecycle.close();
	});

	test("reserves the profile while launch is pending and releases failed launches", async () => {
		let release!: () => void;
		let fail = false;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const lifecycle = createChromiumLifecycle({
			browserType: {
				launchPersistentContext: async () => {
					await wait;
					if (fail) throw new Error("launch failed");
					return { cookies: async () => [], close: async () => undefined };
				},
			},
		});

		const first = lifecycle.startHeadless("account-a");
		await assert.rejects(
			lifecycle.startVisible("account-a"),
			/browser context is already active/,
		);
		fail = true;
		release();
		await assert.rejects(first, /launch failed/);
	});

	test("shares one concurrent close and unlocks only after it succeeds", async () => {
		let closeCalls = 0;
		let finishClose!: () => void;
		const closing = new Promise<void>((resolve) => {
			finishClose = resolve;
		});
		const lifecycle = createChromiumLifecycle({
			browserType: {
				launchPersistentContext: async () => ({
					cookies: async () => [],
					close: async () => {
						closeCalls += 1;
						await closing;
					},
				}),
			},
		});
		await lifecycle.startHeadless("account-a");
		const first = lifecycle.close();
		const second = lifecycle.close();
		await Promise.resolve();
		assert.equal(closeCalls, 1);
		finishClose();
		await Promise.all([first, second]);
		await lifecycle.startHeadless("account-b");
	});

	test("retains the profile lock when context close fails", async () => {
		let launches = 0;
		let closeCalls = 0;
		const lifecycle = createChromiumLifecycle({
			browserType: {
				launchPersistentContext: async () => {
					launches += 1;
					return {
						cookies: async () => [],
						close: async () => {
							closeCalls += 1;
							if (closeCalls === 1) throw new Error("close failed");
						},
					};
				},
			},
		});
		await lifecycle.startHeadless("account-a");
		await assert.rejects(lifecycle.close(), /close failed/);
		await assert.rejects(
			lifecycle.startVisible("account-b"),
			/browser context is already active/,
		);
		await lifecycle.close();
		await lifecycle.startVisible("account-b");
		assert.equal(closeCalls, 2);
		assert.equal(launches, 2);
	});

	test("recovers when close waits on a launch that later fails", async () => {
		let rejectLaunch!: (error: Error) => void;
		let markLaunchStarted!: () => void;
		let launches = 0;
		let closes = 0;
		const launchStarted = new Promise<void>((resolve) => {
			markLaunchStarted = resolve;
		});
		const pending = new Promise<never>((_resolve, reject) => {
			rejectLaunch = reject;
		});
		const lifecycle = createChromiumLifecycle({
			browserType: {
				launchPersistentContext: async () => {
					launches += 1;
					if (launches === 1) {
						markLaunchStarted();
						return pending;
					}
					return {
						cookies: async () => [],
						close: async () => {
							closes += 1;
						},
					};
				},
			},
		});
		const starting = lifecycle.startHeadless("account-a");
		const closing = lifecycle.close();
		const startingRejected = assert.rejects(starting, /launch failed/);
		const closingRejected = assert.rejects(closing, /launch failed/);
		await launchStarted;
		rejectLaunch(new Error("launch failed"));
		await Promise.all([startingRejected, closingRejected]);

		await lifecycle.startHeadless("account-b");
		await lifecycle.close();
		assert.equal(launches, 2);
		assert.equal(closes, 1);
	});
});
