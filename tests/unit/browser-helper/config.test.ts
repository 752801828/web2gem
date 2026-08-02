import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const configModulePath: string = "../../../browser-helper/config.mjs";
const { loadBrowserHelperConfig } = await import(configModulePath);

const REQUIRED = {
	WEB2GEM_INTERNAL_URL: "http://web2gem:52389",
	BROWSER_HELPER_INTERNAL_TOKEN: "test-internal-token",
	NOVNC_PASSWORD: "test-novnc-password",
};

describe("browser helper configuration", () => {
	test("loads safe defaults and disables incomplete Feishu configuration", () => {
		const config = loadBrowserHelperConfig({
			...REQUIRED,
			FEISHU_WEBHOOK_URL:
				"https://open.feishu.cn/open-apis/bot/v2/hook/test-placeholder",
		});
		assert.equal(config.checkIntervalSec, 21_600);
		assert.equal(config.checkJitterSec, 3_600);
		assert.equal(config.autoLoginMaxAttemptsPerDay, 2);
		assert.equal(config.visibleIdleTimeoutSec, 1_800);
		assert.equal(config.controlPort, 6_081);
		assert.equal(config.maxClockSkewSec, 120);
		assert.equal(config.novncPassword, "test-novnc-password");
		assert.equal(config.web2gemInternalUrl, "http://web2gem:52389/");
		assert.equal(config.novncPublicUrl, "http://127.0.0.1:6080/vnc.html");
		assert.equal(config.feishu, null);
	});

	test("enables Feishu only with a safe URL and signing secret", () => {
		const config = loadBrowserHelperConfig({
			...REQUIRED,
			FEISHU_WEBHOOK_URL:
				"https://open.feishu.cn/open-apis/bot/v2/hook/test-placeholder",
			FEISHU_SIGNING_SECRET: "test-signing-secret",
		});
		assert.deepEqual(config.feishu, {
			webhookUrl:
				"https://open.feishu.cn/open-apis/bot/v2/hook/test-placeholder",
			signingSecret: "test-signing-secret",
		});
	});

	test("rejects missing requirements, unsafe URLs, and out-of-bound numbers without echoing input", () => {
		const privateValue = "do-not-echo-private-value";
		for (const env of [
			{},
			{ ...REQUIRED, WEB2GEM_INTERNAL_URL: `https://${privateValue}.example` },
			{
				...REQUIRED,
				NOVNC_PUBLIC_URL: `http://user:${privateValue}@127.0.0.1/vnc.html`,
			},
			{ ...REQUIRED, BROWSER_CHECK_INTERVAL_SEC: "59" },
			{ ...REQUIRED, BROWSER_CHECK_JITTER_SEC: "3601" },
			{ ...REQUIRED, BROWSER_AUTLOGIN_MAX_ATTEMPTS_PER_DAY: "3" },
			{ ...REQUIRED, BROWSER_VISIBLE_IDLE_TIMEOUT_SEC: "59" },
			{ ...REQUIRED, BROWSER_HELPER_CONTROL_PORT: "65536" },
			{ ...REQUIRED, BROWSER_MAX_CLOCK_SKEW_SEC: "301" },
			{
				...REQUIRED,
				FEISHU_WEBHOOK_URL: `https://example.com/${privateValue}`,
				FEISHU_SIGNING_SECRET: privateValue,
			},
		]) {
			let error: unknown;
			try {
				loadBrowserHelperConfig(env);
			} catch (caught) {
				error = caught;
			}
			assert.match(String(error), /invalid browser helper configuration/i);
			assert.doesNotMatch(String(error), new RegExp(privateValue));
		}
	});
});
