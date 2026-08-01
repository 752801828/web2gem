import { createHmac } from "node:crypto";
import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const feishuModulePath: string = "../../../browser-helper/feishu.mjs";
const { createFeishuNotifier, feishuSignature, notificationKey } = await import(
	feishuModulePath
);

const FEISHU = {
	webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test-placeholder",
	signingSecret: "test-signing-secret",
};

const STATE = {
	state: "manual_action_required",
	lastCheckAtMs: 1,
	lastCookieUpdateAtMs: null,
	lastAutoLoginAtMs: 2,
	authFailureCount: 2,
	notificationState: null,
	failureCode: "captcha",
};

describe("Feishu browser notifications", () => {
	test("signs exactly as required by the custom bot protocol", () => {
		const timestamp = 1_596_147_950;
		assert.equal(
			feishuSignature(timestamp, FEISHU.signingSecret),
			createHmac("sha256", `${timestamp}\n${FEISHU.signingSecret}`)
				.update("")
				.digest("base64"),
		);
	});

	test("deduplicates alert states and permits recovery after an alert", () => {
		assert.equal(notificationKey(null, "login_required"), "login_required");
		assert.equal(notificationKey("login_required", "login_required"), null);
		assert.equal(notificationKey("login_required", "ready"), "ready");
		assert.equal(notificationKey("ready", "ready"), null);
		assert.equal(notificationKey(null, "checking"), null);
	});

	test("retries network and 5xx at 1, 5, and 30 seconds, then persists state", async () => {
		const delays: number[] = [];
		const bodies: unknown[] = [];
		let attempts = 0;
		const patches: [string, unknown][] = [];
		const notifier = createFeishuNotifier(
			{
				feishu: FEISHU,
				novncPublicUrl: "http://127.0.0.1:6080/vnc.html",
			},
			{
				clock: () => Date.parse("2026-08-01T00:00:00.000Z"),
				sleep: async (milliseconds: number) => {
					delays.push(milliseconds);
				},
				async fetch(_input: RequestInfo | URL, init?: RequestInit) {
					bodies.push(JSON.parse(String(init?.body)));
					attempts++;
					if (attempts === 1) throw new Error("network secret detail");
					return attempts < 4
						? new Response("", { status: 503 })
						: Response.json({ code: 0, msg: "success" });
				},
				client: {
					async patchState(accountId: string, state: unknown) {
						patches.push([accountId, state]);
					},
				},
			},
		);

		assert.equal(
			await notifier.notifyTransition({
				accountId: "account-123456",
				label: "Primary",
				previousNotificationState: null,
				failureCategory: "captcha",
				stateUpdate: STATE,
			}),
			true,
		);
		assert.deepEqual(delays, [1_000, 5_000, 30_000]);
		assert.equal(bodies.length, 4);
		const text = (bodies[0] as { content: { text: string } }).content.text;
		for (const allowed of [
			"Primary",
			"123456",
			"captcha",
			"2026-08-01T00:00:00.000Z",
			"http://127.0.0.1:6080/vnc.html",
			"Open the visible browser session",
		])
			assert.match(
				text,
				new RegExp(allowed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
		assert.doesNotMatch(
			JSON.stringify(bodies),
			/test-signing-secret|password|cookie/i,
		);
		assert.deepEqual(patches, [
			[
				"account-123456",
				{ ...STATE, notificationState: "manual_action_required" },
			],
		]);
	});

	test("rejects HTTP 200 Feishu business failures without persisting dedupe state", async () => {
		let attempts = 0;
		let patches = 0;
		const notifier = createFeishuNotifier(
			{ feishu: FEISHU, novncPublicUrl: "http://127.0.0.1:6080/vnc.html" },
			{
				clock: () => 0,
				sleep: async () => {
					throw new Error("business failures must not retry");
				},
				async fetch() {
					attempts++;
					return Response.json({
						code: 19_001,
						msg: "private upstream business detail",
					});
				},
				client: {
					async patchState() {
						patches++;
					},
				},
			},
		);

		let error: unknown;
		try {
			await notifier.notifyTransition({
				accountId: "account-a",
				label: "Primary",
				previousNotificationState: null,
				failureCategory: "captcha",
				stateUpdate: STATE,
			});
		} catch (caught) {
			error = caught;
		}
		assert.equal(attempts, 1);
		assert.equal(patches, 0);
		assert.match(String(error), /Feishu notification delivery failed/);
		assert.doesNotMatch(String(error), /19001|private upstream/i);
	});

	test("does not retry 4xx or persist failed/deduplicated delivery", async () => {
		let attempts = 0;
		let patches = 0;
		const notifier = createFeishuNotifier(
			{ feishu: FEISHU, novncPublicUrl: "http://127.0.0.1:6080/vnc.html" },
			{
				clock: () => 0,
				sleep: async () => {
					throw new Error("must not sleep");
				},
				async fetch() {
					attempts++;
					return new Response("private upstream body", { status: 400 });
				},
				client: {
					async patchState() {
						patches++;
					},
				},
			},
		);
		let error: unknown;
		try {
			await notifier.notifyTransition({
				accountId: "account-a",
				label: "Primary",
				previousNotificationState: null,
				failureCategory: "captcha",
				stateUpdate: STATE,
			});
		} catch (caught) {
			error = caught;
		}
		assert.equal(attempts, 1);
		assert.equal(patches, 0);
		assert.doesNotMatch(String(error), /private upstream body|signing-secret/i);

		assert.equal(
			await notifier.notifyTransition({
				accountId: "account-a",
				label: "Primary",
				previousNotificationState: "manual_action_required",
				failureCategory: "captcha",
				stateUpdate: STATE,
			}),
			false,
		);
		assert.equal(attempts, 1);
	});
});
