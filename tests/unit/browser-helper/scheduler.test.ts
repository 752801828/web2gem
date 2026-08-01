import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const schedulerModulePath: string = "../../../browser-helper/scheduler.mjs";
const {
	BrowserMaintenanceError,
	createMaintenanceQueue,
	createBrowserScheduler,
	jitteredDelayMs,
} = await import(schedulerModulePath);

type Job = {
	accountId: string;
	mode: "scheduled" | "manual_check" | "visible";
};
type StateUpdate = {
	state: string;
	lastCheckAtMs: number | null;
	lastCookieUpdateAtMs: number | null;
	lastAutoLoginAtMs: number | null;
	authFailureCount: number;
	notificationState: string | null;
	failureCode: string | null;
};
type NotificationInput = {
	previousNotificationState: string | null;
	stateUpdate: StateUpdate;
};

function lastState(calls: Array<[string, ...unknown[]]>): StateUpdate {
	return calls.filter(([name]) => name === "patch").at(-1)?.[2] as StateUpdate;
}

const account = (overrides: Record<string, unknown> = {}) => ({
	id: "account-a",
	label: "Primary",
	status: {
		credentialsConfigured: true,
		state: "ready",
		lastCheckAtMs: 10,
		lastCookieUpdateAtMs: 11,
		lastAutoLoginAtMs: 12,
		failureCode: null,
	},
	authFailureCount: 0,
	autoLoginAttemptDate: null,
	autoLoginAttemptCount: 0,
	notificationState: null,
	...overrides,
});

function fixture(options: Record<string, unknown> = {}) {
	const calls: Array<[string, ...unknown[]]> = [];
	const accounts = (options.accounts as unknown[]) || [account()];
	const defaultLoginResult = {
		ok: true,
		psid: "private-psid",
		psidts: "private-psidts",
		observedEmail: "owner@example.com",
		automaticLoginUsed: false,
	};
	const loginResults = [
		...((options.loginResults as unknown[]) || [defaultLoginResult]),
	];
	let attemptCount = Number(options.attemptCount || 0);
	const leases = [...((options.leases as boolean[]) || [])];
	const client = {
		serverDate: "Fri, 01 Aug 2026 00:00:00 GMT",
		async listAccounts() {
			calls.push(["list"]);
			if (typeof options.listAccounts === "function")
				return (options.listAccounts as () => unknown)();
			return accounts;
		},
		async acquireLease(id: string, owner: string, ttl: number) {
			calls.push(["acquire", id, owner, ttl]);
			return leases.length ? leases.shift() : options.lease !== false;
		},
		async releaseLease(id: string, owner: string) {
			calls.push(["release", id, owner]);
			if (options.releaseError) throw new Error("private release error");
		},
		async patchState(id: string, state: unknown) {
			calls.push(["patch", id, state]);
		},
		async recordAutoLoginAttempt(id: string, date: string) {
			attemptCount += 1;
			calls.push(["attempt", id, date, attemptCount]);
			return attemptCount;
		},
		async getEncryptedCredentials(id: string) {
			calls.push(["credentials", id]);
			if (options.credentialError)
				throw new BrowserMaintenanceError("credential_fetch_failed");
			return {
				version: 1,
				ciphertext: "cipher",
				nonce: "nonce",
				emailHash: "hash",
			};
		},
		async submitCandidateCookie(id: string, candidate: unknown) {
			calls.push(["candidate", id, candidate]);
			return (
				options.candidateResult || {
					changed: false,
					state: "ready",
					lastCookieUpdateAtMs: null,
				}
			);
		},
	};
	const browser = {
		async startHeadless(id: string) {
			calls.push(["headless", id]);
			return { pages: () => [{}] };
		},
		async startVisible(id: string) {
			calls.push(["visible", id]);
			return { pages: () => [{}] };
		},
		async close() {
			calls.push(["close"]);
			if (options.closeError) throw new Error("private close error");
		},
	};
	const scheduler = createBrowserScheduler(
		{
			checkIntervalSec: 100,
			checkJitterSec: 10,
			autoLoginMaxAttemptsPerDay: 2,
			maxClockSkewSec: 120,
		},
		{
			client,
			browser,
			clock: () => Date.UTC(2026, 7, 1, 12),
			random: () => 0.5,
			owner: "helper-1",
			decryptCredentials(_id: string, _envelope: unknown) {
				calls.push(["decrypt"]);
				if (options.decryptError)
					throw new BrowserMaintenanceError("credential_decrypt_failed");
				return {
					email: "owner@example.com",
					password: "private-password",
					totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
				};
			},
			async runLogin(input: Record<string, unknown>) {
				calls.push(["login", Boolean(input.credentials), input.mode]);
				if (typeof options.runLogin === "function")
					return (options.runLogin as (value: unknown) => unknown)(input);
				if (input.credentials && typeof input.beforeSubmit === "function")
					await (input.beforeSubmit as () => Promise<void>)();
				const result = loginResults.shift() ?? defaultLoginResult;
				if (result instanceof Error) throw result;
				return result;
			},
			notifier: {
				async notifyTransition(input: unknown) {
					calls.push(["notify", input]);
					if (options.notificationError)
						throw new Error("private notification error");
					return true;
				},
			},
			onOperationalError(code: string) {
				calls.push(["operational-error", code]);
			},
			...(options.schedulerDependencies as Record<string, unknown>),
		},
	);
	return { scheduler, calls, client, browser };
}

describe("browser maintenance scheduler", () => {
	test("applies bounded symmetric jitter", () => {
		assert.equal(
			jitteredDelayMs(100, 10, () => 0),
			90_000,
		);
		assert.equal(
			jitteredDelayMs(100, 10, () => 0.5),
			100_000,
		);
		assert.equal(
			jitteredDelayMs(100, 10, () => 1),
			110_000,
		);
	});

	test("runs one global job, deduplicates pending accounts, and upgrades priority", async () => {
		const order: string[] = [];
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queue = createMaintenanceQueue(async ({ accountId, mode }: Job) => {
			order.push(`${accountId}:${mode}`);
			if (accountId === "active") await blocked;
		});
		const active = queue.enqueue({ accountId: "active", mode: "scheduled" });
		queue.enqueue({ accountId: "b", mode: "scheduled" });
		const upgraded = queue.enqueue({ accountId: "b", mode: "visible" });
		queue.enqueue({ accountId: "c", mode: "manual_check" });
		release();
		await Promise.all([active, upgraded, queue.waitForIdle()]);
		assert.deepEqual(order, [
			"active:scheduled",
			"b:visible",
			"c:manual_check",
		]);
	});

	test("does not lose work enqueued while the previous worker is settling", async () => {
		const order: string[] = [];
		const queue = createMaintenanceQueue(async ({ accountId }: Job) => {
			order.push(accountId);
		});
		await queue.enqueue({ accountId: "first", mode: "scheduled" });
		await queue.enqueue({ accountId: "second", mode: "scheduled" });
		await queue.waitForIdle();
		assert.deepEqual(order, ["first", "second"]);
	});

	test("scans only enabled accounts returned by the private API", async () => {
		const { scheduler, calls } = fixture({
			accounts: [account(), account({ id: "account-b" })],
		});
		await scheduler.scan();
		await scheduler.waitForIdle();
		assert.deepEqual(
			calls.filter(([name]) => name === "acquire").map((call) => call[1]),
			["account-a", "account-b"],
		);
	});

	test("skips a lease conflict before state or browser mutation", async () => {
		const { scheduler, calls } = fixture({ lease: false });
		await scheduler.enqueue({ accountId: "account-a", mode: "scheduled" });
		assert.deepEqual(
			calls.map(([name]) => name),
			["list", "acquire"],
		);
	});

	test("recovers after a stale lease expires without retaining queue state", async () => {
		const { scheduler, calls } = fixture({ leases: [false, true] });
		await scheduler.enqueue({ accountId: "account-a", mode: "scheduled" });
		await scheduler.enqueue({ accountId: "account-a", mode: "manual_check" });
		assert.equal(calls.filter(([name]) => name === "acquire").length, 2);
		assert.equal(calls.filter(([name]) => name === "headless").length, 1);
	});

	test("does not replace an account snapshot while its maintenance job is active", async () => {
		let releaseLogin!: () => void;
		const waiting = new Promise<void>((resolve) => {
			releaseLogin = resolve;
		});
		const active = fixture({
			async runLogin() {
				await waiting;
				return {
					ok: true,
					psid: "psid",
					psidts: "psidts",
					observedEmail: "owner@example.com",
					automaticLoginUsed: false,
				};
			},
		});
		const job = active.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		await Promise.resolve();
		const scanning = active.scheduler.scan();
		await Promise.resolve();
		assert.equal(active.calls.filter(([name]) => name === "list").length, 1);
		releaseLogin();
		await Promise.all([job, scanning, active.scheduler.waitForIdle()]);
		assert.equal(active.calls.filter(([name]) => name === "list").length, 2);
	});

	test("treats unchanged candidate cookies as ready and preserves a legacy timestamp", async () => {
		const { scheduler, calls } = fixture();
		await scheduler.enqueue({ accountId: "account-a", mode: "manual_check" });
		const patches = calls
			.filter(([name]) => name === "patch")
			.map((call) => call[2] as StateUpdate);
		assert.equal(patches[0]?.state, "checking");
		assert.deepEqual(patches.at(-1), {
			state: "ready",
			lastCheckAtMs: Date.UTC(2026, 7, 1, 12),
			lastCookieUpdateAtMs: 11,
			lastAutoLoginAtMs: 12,
			authFailureCount: 0,
			notificationState: null,
			failureCode: null,
		});
		assert.deepEqual(
			calls.slice(-2).map(([name]) => name),
			["close", "release"],
		);
	});

	test("records the persistent daily attempt only at the first submission boundary", async () => {
		const first = fixture({
			loginResults: [
				{ ok: false, code: "login_failed" },
				{
					ok: true,
					psid: "psid",
					psidts: "psidts",
					observedEmail: "owner@example.com",
					automaticLoginUsed: true,
				},
			],
		});
		await first.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		const names = first.calls.map(([name]) => name);
		assert.equal(names.indexOf("credentials") < names.indexOf("decrypt"), true);
		assert.equal(names.indexOf("decrypt") < names.indexOf("attempt"), true);
		assert.deepEqual(
			first.calls.filter(([name]) => name === "login").map((call) => call[1]),
			[false, true],
		);

		const capped = fixture({
			accounts: [
				account({
					autoLoginAttemptDate: "2026-08-01",
					autoLoginAttemptCount: 2,
				}),
			],
			attemptCount: 2,
			loginResults: [{ ok: false, code: "login_failed" }],
		});
		await capped.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		assert.equal(
			capped.calls.some(([name]) => name === "attempt"),
			false,
		);
		assert.equal(
			capped.calls.some(([name]) => name === "credentials"),
			false,
		);
	});

	test("does not consume an automatic-login attempt on credential maintenance failures", async () => {
		for (const failure of ["credentialError", "decryptError"] as const) {
			const active = fixture({
				[failure]: true,
				loginResults: [{ ok: false, code: "login_failed" }],
			});
			await active.scheduler.enqueue({
				accountId: "account-a",
				mode: "scheduled",
			});
			assert.equal(
				active.calls.some(([name]) => name === "attempt"),
				false,
			);
			const state = lastState(active.calls);
			assert.equal(state.state, "error");
			assert.equal(state.authFailureCount, 0);
		}
	});

	test("does not enter credentials for missing-cookie checks, explicit challenges, or visible sessions", async () => {
		for (const [mode, code] of [
			["scheduled", "missing_cookie"],
			["scheduled", "captcha"],
			["visible", "login_failed"],
		] as const) {
			const current = fixture({ loginResults: [{ ok: false, code }] });
			await current.scheduler.enqueue({ accountId: "account-a", mode });
			assert.equal(
				current.calls.some(([name]) => name === "attempt"),
				false,
			);
			assert.equal(
				current.calls.some(([name]) => name === "credentials"),
				false,
			);
			assert.deepEqual(
				current.calls
					.filter(([name]) => name === "login")
					.map((call) => call[1]),
				[false],
			);
			assert.equal(current.calls.find(([name]) => name === "login")?.[2], mode);
		}
	});

	test("does not automatically log in a profile already awaiting manual action", async () => {
		const active = fixture({
			accounts: [
				account({
					status: { ...account().status, state: "manual_action_required" },
				}),
			],
			loginResults: [{ ok: false, code: "login_failed" }],
		});
		await active.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		assert.equal(
			active.calls.some(([name]) => name === "attempt"),
			false,
		);
		assert.equal(
			active.calls.some(([name]) => name === "credentials"),
			false,
		);
		assert.equal(lastState(active.calls).state, "manual_action_required");
	});

	test("keeps the persisted attempt count in memory across consecutive jobs", async () => {
		const active = fixture({
			loginResults: [
				{ ok: false, code: "login_failed" },
				{ ok: false, code: "login_failed" },
				{ ok: false, code: "login_failed" },
				{ ok: false, code: "login_failed" },
				{ ok: false, code: "login_failed" },
			],
		});
		for (let index = 0; index < 3; index += 1)
			await active.scheduler.enqueue({
				accountId: "account-a",
				mode: "scheduled",
			});
		assert.equal(active.calls.filter(([name]) => name === "attempt").length, 2);
	});

	test("requires two ordinary auth failures but routes explicit challenges directly to manual action", async () => {
		const first = fixture({
			accounts: [
				account({
					authFailureCount: 0,
					status: { ...account().status, credentialsConfigured: false },
				}),
			],
			loginResults: [{ ok: false, code: "missing_cookie" }],
		});
		await first.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		const firstState = lastState(first.calls);
		assert.equal(firstState.state, "error");
		assert.equal(firstState.authFailureCount, 1);

		const second = fixture({
			accounts: [
				account({
					authFailureCount: 1,
					status: { ...account().status, credentialsConfigured: false },
				}),
			],
			loginResults: [{ ok: false, code: "login_failed" }],
		});
		await second.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		const secondState = lastState(second.calls);
		assert.equal(secondState.state, "login_required");
		assert.equal(secondState.authFailureCount, 2);

		for (const code of [
			"captcha",
			"passkey",
			"phone_approval",
			"recovery",
			"device_confirmation",
			"unknown_page",
		]) {
			const challenge = fixture({ loginResults: [{ ok: false, code }] });
			await challenge.scheduler.enqueue({
				accountId: "account-a",
				mode: "scheduled",
			});
			const state = lastState(challenge.calls);
			assert.equal(state.state, "manual_action_required");
			assert.equal(state.authFailureCount, 0);
		}
	});

	test("notifies one recovery transition and skips ready-to-ready notification", async () => {
		const recovering = fixture({
			accounts: [account({ notificationState: "login_required" })],
		});
		await recovering.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		await recovering.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		const notifications = recovering.calls.filter(
			([name]) => name === "notify",
		);
		assert.equal(notifications.length, 1);
		const notification = notifications[0]?.[1] as NotificationInput;
		assert.equal(notification.previousNotificationState, "login_required");
		assert.equal(notification.stateUpdate.state, "ready");
	});

	test("classifies maintenance failures without auth penalties and contains notifier failures", async () => {
		const { scheduler, calls } = fixture({
			loginResults: [new BrowserMaintenanceError("navigation_failed")],
			notificationError: true,
		});
		await scheduler.enqueue({ accountId: "account-a", mode: "scheduled" });
		const state = lastState(calls);
		assert.equal(state.state, "error");
		assert.equal(state.authFailureCount, 0);
		assert.equal(state.failureCode, "navigation_failed");
		assert.equal(
			calls.some(([name]) => name === "operational-error"),
			true,
		);
		assert.deepEqual(
			calls.slice(-2).map(([name]) => name),
			["close", "release"],
		);
	});

	test("treats clock skew as maintenance rather than authentication failure", async () => {
		const active = fixture({
			loginResults: [new BrowserMaintenanceError("clock_skew")],
		});
		await active.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		const state = lastState(active.calls);
		assert.equal(state.state, "error");
		assert.equal(state.failureCode, "clock_skew");
		assert.equal(state.authFailureCount, 0);
	});

	test("does not count unknown safe login results as authentication failures", async () => {
		const active = fixture({
			loginResults: [{ ok: false, code: "future_safe_code" }],
		});
		await active.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		const state = lastState(active.calls);
		assert.equal(state.state, "error");
		assert.equal(state.authFailureCount, 0);
		assert.equal(state.failureCode, "future_safe_code");
	});

	test("clean shutdown waits for the active job and best-effort closes its browser and lease", async () => {
		let releaseLogin!: () => void;
		const waiting = new Promise<void>((resolve) => {
			releaseLogin = resolve;
		});
		const active = fixture({
			async runLogin() {
				await waiting;
				return { ok: false, code: "login_failed" };
			},
		});
		const job = active.scheduler.enqueue({
			accountId: "account-a",
			mode: "visible",
		});
		await Promise.resolve();
		const stopped = active.scheduler.stop();
		let didStop = false;
		stopped.then(() => {
			didStop = true;
		});
		await Promise.resolve();
		assert.equal(didStop, false);
		releaseLogin();
		await Promise.all([job, stopped]);
		assert.equal(
			active.calls.some(([name]) => name === "visible"),
			true,
		);
		assert.deepEqual(
			active.calls.slice(-2).map(([name]) => name),
			["close", "release"],
		);
		const skipped = await active.scheduler.enqueue({
			accountId: "account-a",
			mode: "visible",
		});
		assert.deepEqual(skipped, { skipped: true });
	});

	test("start arms a jittered timer and stop cancels it", async () => {
		const timers: Array<{ callback: () => void; delay: number }> = [];
		const cleared: unknown[] = [];
		const active = fixture({
			schedulerDependencies: {
				setTimer(callback: () => void, delay: number) {
					const timer = { callback, delay };
					timers.push(timer);
					return timer;
				},
				clearTimer(timer: unknown) {
					cleared.push(timer);
				},
			},
		});
		await active.scheduler.start();
		assert.equal(timers[0]?.delay, 100_000);
		await active.scheduler.stop();
		assert.deepEqual(cleared, [timers[0]]);
	});

	test("retries after an initial scan failure and waits for an active timer scan on stop", async () => {
		const timers: Array<{ callback: () => void }> = [];
		let listCount = 0;
		let releaseScan!: () => void;
		const blocked = new Promise<void>((resolve) => {
			releaseScan = resolve;
		});
		const active = fixture({
			async listAccounts() {
				listCount += 1;
				if (listCount === 1) throw new Error("private list error");
				await blocked;
				return [account()];
			},
			schedulerDependencies: {
				setTimer(callback: () => void) {
					const timer = { callback };
					timers.push(timer);
					return timer;
				},
				clearTimer() {},
			},
		});
		await active.scheduler.start();
		assert.equal(timers.length, 1);
		timers[0]?.callback();
		await Promise.resolve();
		let stopped = false;
		const stopping = active.scheduler.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		assert.equal(stopped, false);
		releaseScan();
		await stopping;
		assert.equal(listCount, 2);
	});

	test("close and release failures remain independent and safely observable", async () => {
		const active = fixture({ closeError: true, releaseError: true });
		await active.scheduler.enqueue({
			accountId: "account-a",
			mode: "scheduled",
		});
		assert.equal(
			active.calls.some(([name]) => name === "close"),
			true,
		);
		assert.equal(
			active.calls.some(([name]) => name === "release"),
			true,
		);
		assert.deepEqual(
			active.calls
				.filter(([name]) => name === "operational-error")
				.map((call) => call[1]),
			["browser_close_failed", "lease_release_failed"],
		);
	});
});
