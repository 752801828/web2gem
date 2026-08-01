import { createHmac } from "node:crypto";

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];
const MAX_RESPONSE_BYTES = 64 * 1_024;
const ALERT_STATES = new Set([
	"login_required",
	"manual_action_required",
	"error",
]);

export class FeishuNotificationError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

export function feishuSignature(timestamp, secret) {
	return createHmac("sha256", `${timestamp}\n${secret}`)
		.update("")
		.digest("base64");
}

export function notificationKey(previousNotificationState, nextState) {
	if (ALERT_STATES.has(nextState))
		return previousNotificationState === nextState ? null : nextState;
	if (nextState === "ready" && ALERT_STATES.has(previousNotificationState))
		return "ready";
	return null;
}

export function createFeishuNotifier(config, options = {}) {
	const fetchImpl = options.fetch || fetch;
	const sleep =
		options.sleep ||
		((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
	const clock = options.clock || Date.now;
	const client = options.client;

	return Object.freeze({
		async notifyTransition(input) {
			if (!config.feishu) return false;
			const key = notificationKey(
				input.previousNotificationState,
				input.stateUpdate.state,
			);
			if (!key) return false;
			const nowMs = clock();
			const timestamp = Math.floor(nowMs / 1_000);
			const body = {
				timestamp: String(timestamp),
				sign: feishuSignature(timestamp, config.feishu.signingSecret),
				msg_type: "text",
				content: {
					text: notificationText(input, config.novncPublicUrl, nowMs),
				},
			};
			await deliver(config.feishu.webhookUrl, body, fetchImpl, sleep);
			try {
				await client.patchState(input.accountId, {
					...input.stateUpdate,
					notificationState: key,
				});
			} catch {
				throw new FeishuNotificationError(
					"feishu_notification_state_failed",
					"notification state could not be persisted",
				);
			}
			return true;
		},
	});
}

async function deliver(url, body, fetchImpl, sleep) {
	for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
		let response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
			});
		} catch {
			if (attempt === RETRY_DELAYS_MS.length) deliveryFailed();
			await sleep(RETRY_DELAYS_MS[attempt]);
			continue;
		}
		if (response.ok) {
			if (await feishuAccepted(response)) return;
			deliveryFailed();
		}
		if (response.status < 500 || attempt === RETRY_DELAYS_MS.length)
			deliveryFailed();
		await sleep(RETRY_DELAYS_MS[attempt]);
	}
}

async function feishuAccepted(response) {
	if (
		!/^application\/json(?:\s*;|$)/i.test(
			response.headers.get("content-type") || "",
		) ||
		!response.body
	)
		return false;
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				return false;
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		const result = JSON.parse(text);
		return (
			result !== null &&
			typeof result === "object" &&
			!Array.isArray(result) &&
			result.code === 0
		);
	} catch {
		return false;
	}
}

function notificationText(input, novncUrl, nowMs) {
	const label = safeLabel(input.label);
	const suffix = String(input.accountId).slice(-6);
	const category =
		typeof input.failureCategory === "string" &&
		/^[a-z0-9_]{1,64}$/.test(input.failureCategory)
		? input.failureCategory
		: "unknown";
	const action =
		input.stateUpdate.state === "ready"
			? "No action required"
			: "Open the visible browser session";
	return [
		`Account: ${label}`,
		`Account ID suffix: ${suffix}`,
		`Failure category: ${category}`,
		`Time: ${new Date(nowMs).toISOString()}`,
		`noVNC: ${novncUrl}`,
		`Action: ${action}`,
	].join("\n");
}

function safeLabel(value) {
	if (typeof value !== "string" || !value.trim()) return "Unlabeled account";
	return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 128);
}

function deliveryFailed() {
	throw new FeishuNotificationError(
		"feishu_notification_failed",
		"Feishu notification delivery failed",
	);
}
