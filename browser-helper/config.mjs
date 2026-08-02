const INVALID_CONFIG = "invalid browser helper configuration";

export function loadBrowserHelperConfig(sourceEnv = process.env) {
	try {
		const web2gemInternalUrl = internalUrl(
			requiredString(sourceEnv.WEB2GEM_INTERNAL_URL),
		);
		const internalToken = requiredSecret(
			sourceEnv.BROWSER_HELPER_INTERNAL_TOKEN,
		);
		const novncPassword = requiredSecret(sourceEnv.NOVNC_PASSWORD);
		const novncPublicUrl = publicNovncUrl(
			stringValue(sourceEnv.NOVNC_PUBLIC_URL) ||
				"http://127.0.0.1:6080/vnc.html",
		);
		const webhook = secretValue(sourceEnv.FEISHU_WEBHOOK_URL);
		const signingSecret = secretValue(sourceEnv.FEISHU_SIGNING_SECRET);

		return Object.freeze({
			web2gemInternalUrl,
			internalToken,
			novncPassword,
			checkIntervalSec: integer(
				sourceEnv.BROWSER_CHECK_INTERVAL_SEC,
				21_600,
				60,
				86_400,
			),
			checkJitterSec: integer(
				sourceEnv.BROWSER_CHECK_JITTER_SEC,
				3_600,
				0,
				3_600,
			),
			autoLoginMaxAttemptsPerDay: integer(
				sourceEnv.BROWSER_AUTLOGIN_MAX_ATTEMPTS_PER_DAY,
				2,
				0,
				2,
			),
			visibleIdleTimeoutSec: integer(
				sourceEnv.BROWSER_VISIBLE_IDLE_TIMEOUT_SEC,
				1_800,
				60,
				86_400,
			),
			visibleSubmissionTimeoutSec: integer(
				sourceEnv.BROWSER_VISIBLE_SUBMISSION_TIMEOUT_SEC,
				180,
				30,
				600,
			),
			controlPort: integer(
				sourceEnv.BROWSER_HELPER_CONTROL_PORT,
				6_081,
				1_024,
				65_535,
			),
			maxClockSkewSec: integer(
				sourceEnv.BROWSER_MAX_CLOCK_SKEW_SEC,
				120,
				0,
				300,
			),
			novncPublicUrl,
			feishu:
				webhook && signingSecret
					? Object.freeze({
							webhookUrl: feishuUrl(webhook),
							signingSecret: requiredSecret(signingSecret),
						})
					: null,
		});
	} catch {
		throw new Error(INVALID_CONFIG);
	}
}

function internalUrl(value) {
	const url = httpUrl(value);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "web2gem" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error(INVALID_CONFIG);
	return url.href;
}

function publicNovncUrl(value) {
	const url = httpUrl(value);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
	)
		throw new Error(INVALID_CONFIG);
	return url.href;
}

function feishuUrl(value) {
	const url = httpUrl(value);
	if (
		url.protocol !== "https:" ||
		!["open.feishu.cn", "open.larksuite.com"].includes(url.hostname) ||
		!url.pathname.startsWith("/open-apis/bot/v2/hook/") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(INVALID_CONFIG);
	return url.href;
}

function httpUrl(value) {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error(INVALID_CONFIG);
	return url;
}

function integer(value, fallback, min, max) {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value))
		throw new Error(INVALID_CONFIG);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
		throw new Error(INVALID_CONFIG);
	return parsed;
}

function stringValue(value) {
	return typeof value === "string" ? value.trim() : "";
}

function requiredString(value) {
	const string = stringValue(value);
	if (!string) throw new Error(INVALID_CONFIG);
	return string;
}

function secretValue(value) {
	return typeof value === "string" && value === value.trim() ? value : "";
}

function requiredSecret(value) {
	const secret = secretValue(value);
	if (!secret || secret.length > 4_096) throw new Error(INVALID_CONFIG);
	return secret;
}
