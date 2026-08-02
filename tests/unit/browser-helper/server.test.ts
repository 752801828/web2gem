import { createHash } from "node:crypto";
import path from "node:path";
import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/server.mjs";
const {
	ControlError,
	createControlRequestHandler,
	createProfileStore,
	createVisibleSessionCoordinator,
} = await import(modulePath);

const TOKEN = "test-control-token";

function request(pathname: string, options: RequestInit = {}) {
	return new Request(`http://browser-helper:6081${pathname}`, options);
}

async function json(response: Response) {
	return { status: response.status, body: await response.json() };
}

describe("browser helper control server", () => {
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
					async open(id: string) {
						calls.push(["open", id]);
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
			enqueue: async (job: { accountId: string; mode: string }) =>
				coordinator.hold(
					{
						accountId: job.accountId,
						page: {},
						mode: job.mode,
						signal: new AbortController().signal,
					},
					async () => {
						calls.push("final-check");
						return { ok: false, code: "login_failed" };
					},
				),
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
					enqueue: (job: { accountId: string; mode: string }) =>
						coordinator.hold(
							{
								accountId: job.accountId,
								page: {},
								mode: job.mode,
								signal: controller.signal,
							},
							async () => {
								finalChecks += 1;
							},
						),
				},
				novnc: { start: async () => undefined, stop: async () => undefined },
				setTimer: () => ({}) as ReturnType<typeof setTimeout>,
				clearTimer: () => undefined,
				prepareVisiblePage: async () => undefined,
			},
		);
		await coordinator.open("account-a");
		controller.abort();
		await coordinator.waitForIdle();
		assert.equal(finalChecks, 0);
		assert.equal(coordinator.isActive("account-a"), false);
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
				isBusy: () => busy,
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
});
