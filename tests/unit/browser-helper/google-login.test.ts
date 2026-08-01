import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/google-login.mjs";
const { classifyGooglePage, createPlaywrightPageAdapter, runGoogleLogin } =
	await import(modulePath);

type State =
	| "authenticated"
	| "email"
	| "password"
	| "totp"
	| "captcha"
	| "passkey"
	| "phone_approval"
	| "recovery"
	| "device_confirmation"
	| "unknown";

const urls: Record<State, string> = {
	authenticated: "https://gemini.google.com/app",
	email: "https://accounts.google.com/v3/signin/identifier",
	password: "https://accounts.google.com/v3/signin/challenge/pwd",
	totp: "https://accounts.google.com/v3/signin/challenge/totp",
	captcha: "https://accounts.google.com/v3/signin/challenge/recaptcha",
	passkey: "https://accounts.google.com/v3/signin/challenge/pk",
	phone_approval: "https://accounts.google.com/v3/signin/challenge/ipp",
	recovery: "https://accounts.google.com/v3/signin/challenge/recovery",
	device_confirmation: "https://accounts.google.com/v3/signin/challenge/dp",
	unknown: "https://accounts.google.com/v3/signin/challenge/selection",
};

function pageFor(state: State) {
	return {
		url: () => urls[state],
		visible: async (candidate: State) => candidate === state,
	};
}

function scriptedPage(
	states: State[],
	options: {
		cookies?: Array<{ name: string; value: string }>;
		email?: string | null;
		rejectTotpFor?: number;
		unchanged?: boolean;
	} = {},
) {
	let index = 0;
	let totpAttempts = 0;
	let waitResult = "changed";
	const submissions: Array<[State, string]> = [];
	return {
		submissions,
		gotoGemini: async () => undefined,
		url: () => urls[states[index] ?? "unknown"],
		visible: async (candidate: State) => candidate === states[index],
		fillAndSubmit: async (state: State, value: string) => {
			submissions.push([state, value]);
			if (options.unchanged) {
				waitResult = "timeout";
				return;
			}
			if (state === "totp" && totpAttempts++ < (options.rejectTotpFor ?? 0)) {
				waitResult = "rejected";
				return;
			}
			waitResult = "changed";
			index += 1;
		},
		waitForPageChange: async () => waitResult,
		cookies: async () =>
			options.cookies ?? [
				{ name: "__Secure-1PSID", value: "psid-value" },
				{ name: "__Secure-1PSIDTS", value: "psidts-value" },
			],
		observedEmail: async () =>
			options.email === undefined ? "owner@example.com" : options.email,
	};
}

const credentials = {
	email: "owner@example.com",
	password: "password-placeholder",
	totpSecret: "not-returned-or-logged",
};

describe("bounded Google login", () => {
	test("classifies authenticated, expected form, and challenge states", async () => {
		for (const state of Object.keys(urls) as State[])
			assert.equal(await classifyGooglePage(pageFor(state)), state);
	});

	test("never submits an explicit security challenge", async () => {
		for (const state of [
			"captcha",
			"passkey",
			"phone_approval",
			"recovery",
			"device_confirmation",
		] as const) {
			const page = scriptedPage([state]);
			assert.deepEqual(
				await runGoogleLogin({ page, credentials, totpCodes: ["111111"] }),
				{ ok: false, code: state },
			);
			assert.equal(page.submissions.length, 0);
		}
	});

	test("never submits credentials to an unexpected hostname", async () => {
		for (const state of ["email", "password", "totp"] as const) {
			const page = scriptedPage([state]);
			page.url = () => `https://accounts.google.com.evil.example/${state}`;
			assert.deepEqual(
				await runGoogleLogin({ page, credentials, totpCodes: ["111111"] }),
				{ ok: false, code: "unknown_page" },
			);
			assert.equal(page.submissions.length, 0);
		}
	});

	test("requires exact HTTPS origins before trusting login or Gemini state", async () => {
		for (const origin of [
			"http://accounts.google.com",
			"https://accounts.google.com:444",
		]) {
			for (const state of ["email", "password", "totp"] as const) {
				const page = scriptedPage([state]);
				page.url = () => `${origin}/${state}`;
				assert.deepEqual(
					await runGoogleLogin({ page, credentials, totpCodes: ["111111"] }),
					{ ok: false, code: "unknown_page" },
				);
				assert.equal(page.submissions.length, 0);
			}
		}

		for (const url of [
			"http://gemini.google.com/app",
			"https://gemini.google.com:444/app",
			"http://www.google.com/sorry/index",
			"https://www.google.com:444/sorry/index",
		]) {
			const page = pageFor("authenticated");
			page.url = () => url;
			assert.equal(await classifyGooglePage(page), "unknown");
		}
		const sorry = pageFor("captcha");
		sorry.url = () => "https://www.google.com/sorry/index";
		assert.equal(await classifyGooglePage(sorry), "captcha");
	});

	test("submits only email, password, and bounded TOTP candidates", async () => {
		const page = scriptedPage(["email", "password", "totp", "authenticated"], {
			rejectTotpFor: 2,
		});
		assert.deepEqual(
			await runGoogleLogin({
				page,
				credentials,
				totpCodes: ["111111", "222222", "333333"],
			}),
			{
				ok: true,
				psid: "psid-value",
				psidts: "psidts-value",
				observedEmail: "owner@example.com",
				automaticLoginUsed: true,
			},
		);
		assert.deepEqual(page.submissions, [
			["email", "owner@example.com"],
			["password", "password-placeholder"],
			["totp", "111111"],
			["totp", "222222"],
			["totp", "333333"],
		]);
	});

	test("does not try another TOTP candidate when the page is unchanged", async () => {
		const page = scriptedPage(["totp"], { unchanged: true });
		assert.deepEqual(
			await runGoogleLogin({
				page,
				credentials,
				totpCodes: ["111111", "222222", "333333"],
			}),
			{ ok: false, code: "login_failed" },
		);
		assert.deepEqual(page.submissions, [["totp", "111111"]]);
	});

	test("accepts context destruction only when navigation changed the URL", async () => {
		let currentUrl = urls.email;
		let navigateOnSubmit = true;
		const locator = {
			first: () => locator,
			isVisible: async () => false,
			evaluateAll: async () => "",
			fill: async () => undefined,
			press: async () => {
				if (navigateOnSubmit) currentUrl = urls.password;
			},
		};
		const adapter = createPlaywrightPageAdapter({
			url: () => currentUrl,
			locator: () => locator,
			waitForFunction: async () => {
				throw new Error("Execution context was destroyed");
			},
		});

		await adapter.fillAndSubmit("email", credentials.email);
		assert.equal(await adapter.waitForPageChange("email"), "changed");
		navigateOnSubmit = false;
		await adapter.fillAndSubmit("password", credentials.password);
		await assert.rejects(
			adapter.waitForPageChange("password"),
			/Execution context was destroyed/,
		);
	});

	test("does not resubmit a stuck email or password state", async () => {
		for (const state of ["email", "password"] as const) {
			const page = scriptedPage([state], { unchanged: true });
			assert.deepEqual(
				await runGoogleLogin({ page, credentials, totpCodes: [] }),
				{ ok: false, code: "login_failed" },
			);
			assert.equal(page.submissions.length, 1);
		}
	});

	test("requires both cookies and a reliable observed email", async () => {
		const missingCookie = scriptedPage(["authenticated"], {
			cookies: [{ name: "__Secure-1PSID", value: "present" }],
		});
		assert.deepEqual(
			await runGoogleLogin({
				page: missingCookie,
				credentials,
				totpCodes: [],
			}),
			{ ok: false, code: "missing_cookie" },
		);

		const missingIdentity = scriptedPage(["authenticated"], { email: null });
		assert.deepEqual(
			await runGoogleLogin({
				page: missingIdentity,
				credentials,
				totpCodes: [],
			}),
			{ ok: false, code: "login_failed" },
		);
	});

	test("reports an already-authenticated profile without automatic login", async () => {
		assert.equal(
			(
				await runGoogleLogin({
					page: scriptedPage(["authenticated"]),
					credentials,
					totpCodes: [],
				})
			).automaticLoginUsed,
			false,
		);
	});
});
