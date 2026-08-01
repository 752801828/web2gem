import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/google-login.mjs";
const { classifyGooglePage, runGoogleLogin } = await import(modulePath);

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
		stayTotpFor?: number;
	} = {},
) {
	let index = 0;
	let totpAttempts = 0;
	const submissions: Array<[State, string]> = [];
	return {
		submissions,
		gotoGemini: async () => undefined,
		url: () => urls[states[index] ?? "unknown"],
		visible: async (candidate: State) => candidate === states[index],
		fillAndSubmit: async (state: State, value: string) => {
			submissions.push([state, value]);
			if (state === "totp" && totpAttempts++ < (options.stayTotpFor ?? 0))
				return;
			index += 1;
		},
		waitForPageChange: async () => undefined,
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

	test("submits only email, password, and bounded TOTP candidates", async () => {
		const page = scriptedPage(["email", "password", "totp", "authenticated"], {
			stayTotpFor: 2,
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

	test("does not resubmit a stuck email or password state", async () => {
		for (const state of ["email", "password"] as const) {
			const page = scriptedPage([state, state]);
			page.fillAndSubmit = async (submittedState: State, value: string) => {
				page.submissions.push([submittedState, value]);
			};
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
