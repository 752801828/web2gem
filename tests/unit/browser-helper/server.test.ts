import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/server.mjs";
const {
	ControlError,
	createControlRequestHandler,
	createHelperControlServer,
	createProfileStore,
	createVisibleSessionCoordinator,
	installPageActivityTracking,
} = await import(modulePath);

const TOKEN = "test-control-token";

function request(pathname: string, options: RequestInit = {}) {
	return new Request(`http://browser-helper:6081${pathname}`, options);
}

async function json(response: Response) {
	return { status: response.status, body: await response.json() };
}

describe("browser helper control server", () => {
	test("preserves a server close failure while draining", async () => {
		const fakeServer = Object.assign(new EventEmitter(), {
			close(callback: (error?: Error) => void) {
				callback(new Error("close failed"));
			},
			closeAllConnections() {},
			listen() {},
		});
		const server = createHelperControlServer(
			{ controlToken: TOKEN, controlPort: 6081 },
			{
				createServer: () => fakeServer,
				scheduler: { enqueue: async () => undefined, isBusy: () => false },
				sessions: { open: async () => undefined, stop: async () => undefined },
				profiles: { remove: async () => undefined },
				sleep: async () => undefined,
			},
		);
		server.beginStop();
		await assert.rejects(server.drain(), /close failed/);
	});

	test("has a public health check and timing-safe Bearer authentication", async () => {
		const handler = createControlRequestHandler(
			{ controlToken: TOKEN },
			{
				scheduler: { enqueue: async () => undefined, isBusy: () => false },
				sessions: { open: async () => undefined, stop: async () => undefined },
				profiles: { remove: async () => undefined },
			},
		);
		assert.deepEqual(await json(await handler(request("/health"))), {
			status: 200,
			body: { status: "ok" },
		});
		for (const authorization of [undefined, "Bearer wrong", `Basic ${TOKEN}`]) {
			const response = await handler(
				request("/checks/account-a", {
					method: "POST",
					headers: authorization ? { authorization } : {},
				}),
			);
			assert.equal(response.status, 401);
		}
	});

	test("routes strict empty JSON actions and returns safe conflicts", async () => {
		const calls: unknown[][] = [];
		let openSignal: AbortSignal | undefined;
		const handler = createControlRequestHandler(
			{ controlToken: TOKEN },
			{
				scheduler: {
					enqueue(input: unknown) {
						calls.push(["enqueue", input]);
					},
					isBusy: () => false,
				},
				sessions: {
					async open(id: string, signal: AbortSignal) {
						calls.push(["open", id]);
						openSignal = signal;
						if (id === "conflict")
							throw new ControlError(409, "visible_session_conflict");
					},
					async stop() {
						calls.push(["stop"]);
					},
					isActive: () => false,
				},
				profiles: {
					async remove(id: string) {
						calls.push(["remove", id]);
					},
				},
			},
		);
		const auth = {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		};
		for (const [method, pathname] of [
			["POST", "/checks/account-a"],
			["POST", "/sessions/account-a/open"],
			["POST", "/sessions/stop"],
			["DELETE", "/profiles/account-a"],
		] as const) {
			const response = await handler(
				request(pathname, { method, headers: auth, body: "{}" }),
			);
			assert.equal(response.status, 200);
		}
		assert.deepEqual(calls, [
			["enqueue", { accountId: "account-a", mode: "manual_check" }],
			["open", "account-a"],
			["stop"],
			["remove", "account-a"],
		]);
		assert.equal(openSignal instanceof AbortSignal, true);
		assert.deepEqual(
			await json(
				await handler(
					request("/sessions/conflict/open", {
						method: "POST",
						headers: auth,
						body: "{}",
					}),
				),
			),
			{
				status: 409,
				body: { error: { code: "visible_session_conflict" } },
			},
		);
	});

	test("rejects wrong methods, paths, IDs, JSON, and bodies over 64 KiB", async () => {
		const handler = createControlRequestHandler(
			{ controlToken: TOKEN },
			{
				scheduler: { enqueue: async () => undefined, isBusy: () => false },
				sessions: { open: async () => undefined, stop: async () => undefined },
				profiles: { remove: async () => undefined },
			},
		);
		const auth = { authorization: `Bearer ${TOKEN}` };
		for (const input of [
			request("/health", { method: "POST" }),
			request("/unknown", { method: "POST", headers: auth }),
			request("/checks/%2F", { method: "POST", headers: auth }),
			request("/checks/account-a", {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: "{",
			}),
			request("/checks/account-a", {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ extra: true }),
			}),
			request("/checks/account-a", {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ pad: "x".repeat(65 * 1024) }),
			}),
		]) {
			const response = await handler(input);
			assert.equal(response.status >= 400, true);
		}
	});
});

describe("visible browser sessions", () => {
	test("allows one account, then performs exactly one final check before stopping noVNC", async () => {
		const calls: string[] = [];
		let coordinator: ReturnType<typeof createVisibleSessionCoordinator>;
		const scheduler = {
			enqueue: async (job: { accountId: string; mode: string }) => {
				const signal = new AbortController().signal;
				await coordinator.beforeVisibleStart(job.accountId, signal);
				return coordinator.hold(
					{
						accountId: job.accountId,
						page: {},
						mode: job.mode,
						signal,
					},
					async () => {
						calls.push("final-check");
						return { ok: false, code: "login_failed" };
					},
				);
			},
		};
		coordinator = createVisibleSessionCoordinator(
			{ visibleIdleTimeoutSec: 60 },
			{
				scheduler,
				novnc: {
					async start() {
						calls.push("novnc-start");
					},
					async stop() {
						calls.push("novnc-stop");
					},
				},
				setTimer: () => ({}) as ReturnType<typeof setTimeout>,
				clearTimer: () => undefined,
				prepareVisiblePage: async () => undefined,
				trackActivity: async () => undefined,
			},
		);
		await coordinator.open("account-a");
		await assert.rejects(
			coordinator.open("account-b"),
			/visible session conflict/,
		);
		await coordinator.stop();
		assert.deepEqual(calls, ["novnc-start", "final-check", "novnc-stop"]);
		assert.equal(coordinator.isActive("account-a"), false);
	});

	test("aborts without a final cookie check when the maintenance lease is lost", async () => {
		let finalChecks = 0;
		let coordinator: ReturnType<typeof createVisibleSessionCoordinator>;
		const controller = new AbortController();
		coordinator = createVisibleSessionCoordinator(
			{ visibleIdleTimeoutSec: 60 },
			{
				scheduler: {
					async enqueue(job: { accountId: string; mode: string }) {
						await coordinator.beforeVisibleStart(
							job.accountId,
							controller.signal,
						);
						return coordinator.hold(
							{
								accountId: job.accountId,
								page: {},
								mode: job.mode,
								signal: controller.signal,
							},
							async () => {
								finalChecks += 1;
							},
						);
					},
				},
				novnc: { start: async () => undefined, stop: async () => undefined },
				setTimer: () => ({}) as ReturnType<typeof setTimeout>,
				clearTimer: () => undefined,
				prepareVisiblePage: async () => undefined,
				trackActivity: async () => undefined,
			},
		);
		await coordinator.open("account-a");
		controller.abort();
		await coordinator.waitForIdle();
		assert.equal(finalChecks, 0);
		assert.equal(coordinator.isActive("account-a"), false);
	});

	test("cancels an open that disconnects before readiness without leaving an active session", async () => {
		let coordinator: ReturnType<typeof createVisibleSessionCoordinator>;
		let releasePreparation!: () => void;
		const preparing = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		const caller = new AbortController();
		coordinator = createVisibleSessionCoordinator(
			{ visibleIdleTimeoutSec: 60 },
			{
				scheduler: {
					async enqueue(job: {
						accountId: string;
						mode: string;
						signal?: AbortSignal;
					}) {
						await coordinator.beforeVisibleStart(job.accountId, job.signal);
						return coordinator.hold(
							{
								accountId: job.accountId,
								page: {},
								mode: job.mode,
								signal: job.signal,
							},
							async () => ({ ok: false, code: "login_failed" }),
						);
					},
				},
				novnc: { start: async () => undefined, stop: async () => undefined },
				prepareVisiblePage: async () => preparing,
				trackActivity: async () => undefined,
				setTimer: () => ({}) as ReturnType<typeof setTimeout>,
				clearTimer: () => undefined,
			},
		);
		const opening = coordinator.open("account-a", caller.signal);
		await Promise.resolve();
		caller.abort();
		await assert.rejects(opening, /request aborted/);
		assert.equal(coordinator.isActive("account-a"), false);
		releasePreparation();
	});

	test("resets idle on activity and recovers from a same-page submission", async () => {
		const timers: Array<() => void> = [];
		const cleared: unknown[] = [];
		let hooks: Record<string, () => void> | undefined;
		const submissionTimers: Array<() => void> = [];
		let finalChecks = 0;
		let coordinator: ReturnType<typeof createVisibleSessionCoordinator>;
		coordinator = createVisibleSessionCoordinator(
			{ visibleIdleTimeoutSec: 60 },
			{
				scheduler: {
					async enqueue(job: { accountId: string; mode: string }) {
						const signal = new AbortController().signal;
						await coordinator.beforeVisibleStart(job.accountId, signal);
						return coordinator.hold(
							{
								accountId: job.accountId,
								page: {},
								mode: job.mode,
								signal,
							},
							async () => {
								finalChecks += 1;
								return { ok: false, code: "login_failed" };
							},
						);
					},
				},
				novnc: { start: async () => undefined, stop: async () => undefined },
				prepareVisiblePage: async () => undefined,
				trackActivity(_page: unknown, input: Record<string, () => void>) {
					hooks = input;
					return () => undefined;
				},
				setTimer(callback: () => void) {
					timers.push(callback);
					return callback as unknown as ReturnType<typeof setTimeout>;
				},
				clearTimer(timer: unknown) {
					cleared.push(timer);
				},
				setSubmissionTimer(callback: () => void) {
					submissionTimers.push(callback);
					return callback;
				},
				clearSubmissionTimer: () => undefined,
			},
		);
		await coordinator.open("account-a");
		assert.equal(timers.length, 1);
		hooks?.activity();
		assert.equal(timers.length, 2);
		assert.equal(cleared.includes(timers[0]), true);
		hooks?.submissionStart();
		assert.equal(timers.length, 3);
		timers.at(-1)?.();
		await Promise.resolve();
		assert.equal(finalChecks, 0);
		assert.equal(coordinator.isActive("account-a"), true);
		hooks?.activity();
		assert.equal(timers.length, 3);
		assert.equal(coordinator.isActive("account-a"), true);
		assert.equal(submissionTimers.length, 1);
		submissionTimers[0]?.();
		await coordinator.waitForIdle();
		assert.equal(finalChecks, 1);
		assert.equal(coordinator.isActive("account-a"), false);
	});

	test("ends submission protection on main-frame navigation", async () => {
		const events = new Map<string, (...args: unknown[]) => void>();
		let bindingCallback:
			| ((_source: unknown, event: string) => void)
			| undefined;
		const page = {
			exposeBinding: async (
				_name: string,
				callback: (_source: unknown, event: string) => void,
			) => {
				bindingCallback = callback;
			},
			addInitScript: async () => undefined,
			evaluate: async () => undefined,
			on(name: string, callback: (...args: unknown[]) => void) {
				events.set(name, callback);
			},
			off: () => undefined,
			mainFrame: () => page,
		};
		const calls: string[] = [];
		const cleanup = await installPageActivityTracking(page, {
			activity: () => calls.push("activity"),
			submissionStart: () => calls.push("start"),
			submissionEnd: () => calls.push("end"),
		});
		bindingCallback?.({}, "submission-start");
		events.get("framenavigated")?.(page);
		assert.deepEqual(calls, ["start", "end"]);
		await cleanup();
	});
});

describe("browser profile deletion", () => {
	test("uses only the SHA-256 directory, rejects busy profiles, and never follows a symlink", async () => {
		const removed: unknown[][] = [];
		const root = path.resolve("profile-root");
		let busy = true;
		let symbolic = false;
		const store = createProfileStore(
			{ profilesRoot: root },
			{
				reserve: () => (busy ? null : () => undefined),
				async lstat() {
					return { isSymbolicLink: () => symbolic };
				},
				async rm(target: string, options: unknown) {
					removed.push([target, options]);
				},
			},
		);
		const accountId = "account .. private";
		await assert.rejects(store.remove(accountId), /profile busy/);
		busy = false;
		symbolic = true;
		await assert.rejects(store.remove(accountId), /profile unsafe/);
		symbolic = false;
		await store.remove(accountId);
		assert.deepEqual(removed, [
			[
				path.join(root, createHash("sha256").update(accountId).digest("hex")),
				{ recursive: true, force: true, maxRetries: 0 },
			],
		]);
	});

	test("holds and releases the scheduler reservation across lstat and rm", async () => {
		const events: string[] = [];
		let releaseStat!: () => void;
		const waiting = new Promise<void>((resolve) => {
			releaseStat = resolve;
		});
		let reserved = false;
		const store = createProfileStore(
			{ profilesRoot: path.resolve("profile-root") },
			{
				reserve() {
					if (reserved) return null;
					reserved = true;
					events.push("reserve");
					return () => {
						reserved = false;
						events.push("release");
					};
				},
				async lstat() {
					events.push("lstat");
					await waiting;
					return { isSymbolicLink: () => false };
				},
				async rm() {
					events.push("rm");
				},
			},
		);
		const deletion = store.remove("account-a");
		await Promise.resolve();
		assert.equal(reserved, true);
		await assert.rejects(store.remove("account-a"), /profile busy/);
		releaseStat();
		await deletion;
		assert.deepEqual(events, ["reserve", "lstat", "rm", "release"]);
		assert.equal(reserved, false);
	});
});
