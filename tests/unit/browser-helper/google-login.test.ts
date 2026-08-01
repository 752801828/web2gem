import { describe, test } from "vitest";
import { assert } from "../assertions.js";

const modulePath: string = "../../../browser-helper/google-login.mjs";
const {
	BrowserMaintenanceError,
	classifyGooglePage,
	createPlaywrightPageAdapter,
	runGoogleLogin,
} = await import(modulePath);

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
		fillAndSubmit: async (
			state: State,
			value: string,
			beforeSubmit?: () => Promise<void>,
		) => {
			await beforeSubmit?.();
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

	test("denies unknown challenge routes before inspecting form controls", async () => {
		for (const route of ["selection", "otp", "unexpected"]) {
			const page = scriptedPage(["totp"]);
			let waits = 0;
			page.url = () =>
				`https://accounts.google.com/v3/signin/challenge/${route}`;
			page.waitForStateReady = async () => {
				waits += 1;
			};
			assert.deepEqual(
				await runGoogleLogin({ page, credentials, totpCodes: ["111111"] }),
				{ ok: false, code: "unknown_page" },
			);
			assert.equal(page.submissions.length, 0);
			assert.equal(waits, 0);
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

	test("binds submission to the classified trusted document", async () => {
		let currentUrl = urls.email;
		let fills = 0;
		let submits = 0;
		const element = {
			isVisible: async () => true,
			evaluate: async (callback: (value: unknown) => unknown) =>
				callback({ form: { action: "https://evil.example/steal" } }),
			fill: async () => {
				fills += 1;
			},
			press: async () => {
				submits += 1;
			},
			dispose: async () => undefined,
		};
		const adapter = createPlaywrightPageAdapter({
			url: () => currentUrl,
			locator: (selector: string) => {
				const locator = {
					first: () => locator,
					isVisible: async () => selector.includes('input[type="email"]'),
					fill: element.fill,
					press: element.press,
					elementHandle: async () => element,
				};
				return locator;
			},
		});

		assert.equal(await classifyGooglePage(adapter), "email");
		currentUrl = "https://evil.example/phishing";
		await assert.rejects(
			adapter.fillAndSubmit("email", credentials.email),
			/browser submission is not trusted/,
		);
		assert.equal(fills, 0);
		assert.equal(submits, 0);

		currentUrl = urls.email;
		await assert.rejects(
			adapter.fillAndSubmit("email", credentials.email),
			/browser submission is not trusted/,
		);
		assert.equal(fills, 0);
		assert.equal(submits, 0);
	});

	test("cleans bound handles when form submission throws", async () => {
		let failPress = true;
		let disposals = 0;
		const control = {
			isVisible: async () => true,
			evaluate: async (callback: (value: unknown) => unknown) =>
				callback({ form: { action: urls.email }, isConnected: true }),
			fill: async () => undefined,
			press: async () => {
				if (failPress) throw new Error("detached with private page detail");
			},
			dispose: async () => {
				disposals += 1;
			},
		};
		const adapter = createPlaywrightPageAdapter(
			{
				url: () => urls.email,
				locator: (selector: string) => {
					const locator = {
						first: () => locator,
						isVisible: async () => selector.includes('input[type="email"]'),
						elementHandle: async () => control,
					};
					return locator;
				},
				waitForTimeout: async () => undefined,
			},
			{ submissionPolls: 1, submissionPollMs: 0 },
		);
		await assert.rejects(
			adapter.fillAndSubmit("email", credentials.email),
			/browser submission is not trusted/,
		);
		assert.equal(disposals, 1);

		failPress = false;
		await adapter.fillAndSubmit("email", credentials.email);
		assert.equal(await adapter.waitForPageChange("email"), "timeout");
		assert.equal(disposals, 2);
	});

	test("cleans partial structured rejection baselines", async () => {
		const cleaned = { control: 0, error: 0, watch: 0, disconnected: 0 };
		const error = {
			isVisible: async () => true,
			getAttribute: async () => "same-code",
			dispose: async () => {
				cleaned.error += 1;
			},
		};
		const watchValue = {
			state: { generation: 0 },
			observer: {
				disconnect: () => {
					cleaned.disconnected += 1;
				},
			},
		};
		const watch = {
			asElement: () => null,
			evaluate: async (callback: (value: typeof watchValue) => unknown) =>
				callback(watchValue),
			dispose: async () => {
				cleaned.watch += 1;
			},
		};
		let evaluateHandleCalls = 0;
		const control = {
			isVisible: async () => true,
			getAttribute: async () => {
				throw new Error("baseline failed");
			},
			evaluate: async (callback: (value: unknown) => unknown) =>
				callback({ form: { action: urls.totp }, isConnected: true }),
			evaluateHandle: async () => {
				evaluateHandleCalls += 1;
				return evaluateHandleCalls === 1
					? { asElement: () => error, dispose: async () => undefined }
					: watch;
			},
			fill: async () => undefined,
			press: async () => undefined,
			dispose: async () => {
				cleaned.control += 1;
			},
		};
		const adapter = createPlaywrightPageAdapter({
			url: () => urls.totp,
			locator: (selector: string) => {
				const locator = {
					first: () => locator,
					isVisible: async () => selector.includes('input[name="totpPin"]'),
					elementHandle: async () => control,
				};
				return locator;
			},
		});
		await assert.rejects(
			adapter.fillAndSubmit("totp", "111111"),
			/browser submission is not trusted/,
		);
		assert.deepEqual(cleaned, {
			control: 1,
			error: 1,
			watch: 1,
			disconnected: 1,
		});
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

	test("runs the automatic-attempt reservation once immediately before the first form submission", async () => {
		const page = scriptedPage(["email", "password", "authenticated"]);
		const events: string[] = [];
		const fillAndSubmit = page.fillAndSubmit;
		page.fillAndSubmit = async (
			state: State,
			value: string,
			beforeSubmit?: () => Promise<void>,
		) => {
			await fillAndSubmit(state, value, beforeSubmit);
			events.push(`submit:${state}`);
		};
		assert.equal(
			(
				await runGoogleLogin({
					page,
					credentials,
					totpCodes: [],
					beforeSubmit: async () => {
						events.push("reserve");
					},
				})
			).ok,
			true,
		);
		assert.deepEqual(events, ["reserve", "submit:email", "submit:password"]);
	});

	test("does not reserve when trusted-element preflight fails", async () => {
		let reservations = 0;
		const control = {
			isVisible: async () => true,
			evaluate: async (callback: (value: unknown) => unknown) =>
				callback({ form: { action: "https://evil.example/steal" } }),
			fill: async () => undefined,
			press: async () => undefined,
			dispose: async () => undefined,
		};
		assert.deepEqual(
			await runGoogleLogin({
				page: createPlaywrightPageAdapter({
					url: () => urls.email,
					goto: async () => undefined,
					locator: (selector: string) => {
						const locator = {
							first: () => locator,
							isVisible: async () => selector.includes('input[type="email"]'),
							elementHandle: async () => control,
						};
						return locator;
					},
				}),
				credentials,
				totpCodes: [],
				beforeSubmit: async () => {
					reservations += 1;
				},
			}),
			{ ok: false, code: "login_failed" },
		);
		assert.equal(reservations, 0);
	});

	test("preflights TOTP clock skew before submitting email", async () => {
		const page = scriptedPage(["email", "totp"]);
		let reservations = 0;
		let error: unknown;
		try {
			await runGoogleLogin({
				page,
				credentials: {
					...credentials,
					totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
				},
				nowSeconds: 100,
				serverDate: new Date(90_000).toUTCString(),
				maxClockSkewSec: 5,
				beforeSubmit: async () => {
					reservations += 1;
				},
			});
		} catch (caught) {
			error = caught;
		}
		assert.equal(error instanceof BrowserMaintenanceError, true);
		assert.equal((error as { code?: string }).code, "clock_skew");
		assert.equal(page.submissions.length, 0);
		assert.equal(reservations, 0);
	});

	test("does not reserve an attempt when login maintenance fails before submission", async () => {
		let reservations = 0;
		await assert.rejects(
			runGoogleLogin({
				page: {
					gotoGemini: async () => {
						throw new Error("private proxy failure");
					},
				},
				credentials,
				beforeSubmit: async () => {
					reservations += 1;
				},
			}),
			/browser maintenance failed/,
		);
		assert.equal(reservations, 0);
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

	test("honors the configured maximum clock skew when generating TOTP", async () => {
		const page = scriptedPage(["totp"]);
		let error: unknown;
		try {
			await runGoogleLogin({
				page,
				credentials: {
					...credentials,
					totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
				},
				nowSeconds: 100,
				serverDate: new Date(90_000).toUTCString(),
				maxClockSkewSec: 5,
			});
		} catch (caught) {
			error = caught;
		}
		assert.equal(error instanceof BrowserMaintenanceError, true);
		assert.equal((error as { code?: string }).code, "clock_skew");
		assert.equal(page.submissions.length, 0);
	});

	test("uses structured TOTP rejection events, not unrelated alerts", async () => {
		type ErrorNode = { code: string; text: string };
		const currentError: ErrorNode = {
			code: "invalid_totp",
			text: "same error",
		};
		let createStructuredMutation = true;
		let unrelatedAlertChanges = 0;
		let disconnectedWatches = 0;
		const queriedSelectors: string[] = [];
		const errorHandle = (node: ErrorNode) => ({
			node,
			isVisible: async () => true,
			getAttribute: async (name: string) =>
				name === "data-error-code" ? node.code : null,
			evaluate: async (
				callback: (value: ErrorNode, previous: ErrorNode) => unknown,
				previous: { node: ErrorNode },
			) => callback(node, previous.node),
			dispose: async () => undefined,
		});
		const controlHandle = () => {
			let evaluateHandleCalls = 0;
			const watch = {
				state: { generation: 0 },
				observer: {
					disconnect: () => {
						disconnectedWatches += 1;
					},
				},
			};
			return {
				isVisible: async () => true,
				getAttribute: async (name: string) =>
					name === "aria-invalid" ? "true" : null,
				evaluate: async (callback: (value: unknown) => unknown) =>
					callback({
						form: { action: urls.totp },
						isConnected: true,
					}),
				evaluateHandle: async () => {
					evaluateHandleCalls += 1;
					if (evaluateHandleCalls === 2)
						return {
							asElement: () => null,
							evaluate: async (callback: (value: typeof watch) => unknown) =>
								callback(watch),
							dispose: async () => undefined,
						};
					const element = errorHandle(currentError);
					return {
						asElement: () => element,
						dispose: async () => undefined,
					};
				},
				fill: async () => undefined,
				press: async () => {
					if (createStructuredMutation) watch.state.generation += 1;
					else unrelatedAlertChanges += 1;
				},
				dispose: async () => undefined,
			};
		};
		const adapter = createPlaywrightPageAdapter(
			{
				url: () => urls.totp,
				locator: (selector: string) => {
					queriedSelectors.push(selector);
					const locator = {
						first: () => locator,
						isVisible: async () => selector.includes('input[name="totpPin"]'),
						elementHandle: async () => controlHandle(),
					};
					return locator;
				},
				waitForTimeout: async () => undefined,
			},
			{ submissionPolls: 1, submissionPollMs: 0 },
		);

		await adapter.fillAndSubmit("totp", "111111");
		assert.equal(await adapter.waitForPageChange("totp"), "rejected");
		await adapter.fillAndSubmit("totp", "222222");
		assert.equal(await adapter.waitForPageChange("totp"), "rejected");

		createStructuredMutation = false;
		await adapter.fillAndSubmit("totp", "333333");
		assert.equal(await adapter.waitForPageChange("totp"), "timeout");
		assert.equal(unrelatedAlertChanges, 1);

		createStructuredMutation = true;
		await adapter.fillAndSubmit("totp", "444444");
		assert.equal(await adapter.waitForPageChange("totp"), "rejected");
		assert.equal(disconnectedWatches, 4);
		assert.equal(
			queriedSelectors.some(
				(selector) =>
					selector.includes('[role="alert"]') || selector.includes("aria-live"),
			),
			false,
		);
	});

	test("accepts context destruction only when navigation changed the URL", async () => {
		let currentUrl = urls.email;
		let navigateOnSubmit = true;
		const control = {
			isVisible: async () => true,
			evaluate: async (callback: (element: unknown) => unknown) =>
				callback({ form: { action: urls.email }, isConnected: true }),
			fill: async () => undefined,
			press: async () => {
				if (navigateOnSubmit) currentUrl = urls.password;
			},
			dispose: async () => undefined,
		};
		const adapter = createPlaywrightPageAdapter(
			{
				url: () => currentUrl,
				locator: (selector: string) => {
					const locator = {
						first: () => locator,
						isVisible: async () =>
							selector.includes('input[type="email"]') ||
							selector.includes('input[type="password"]'),
						elementHandle: async () => control,
					};
					return locator;
				},
				waitForTimeout: async () => {
					throw new Error("Execution context was destroyed");
				},
			},
			{ submissionPolls: 1 },
		);

		await adapter.fillAndSubmit("email", credentials.email);
		assert.equal(await adapter.waitForPageChange("email"), "changed");
		navigateOnSubmit = false;
		await adapter.fillAndSubmit("password", credentials.password);
		await assert.rejects(
			adapter.waitForPageChange("password"),
			/Execution context was destroyed/,
		);
	});

	test("rethrows initial navigation failures as redacted maintenance errors", async () => {
		const leaked = "proxy-password-should-not-leak";
		let error: unknown;
		try {
			await runGoogleLogin({
				page: {
					gotoGemini: async () => {
						throw new Error(leaked);
					},
				},
				credentials,
				totpCodes: [],
			});
		} catch (caught) {
			error = caught;
		}
		assert.equal(error instanceof BrowserMaintenanceError, true);
		assert.equal((error as { code?: string }).code, "navigation_failed");
		assert.doesNotMatch(String(error), new RegExp(leaked));
	});

	test("preserves typed maintenance failures after initial navigation", async () => {
		const leaked = "closed page with private proxy detail";
		const locator = {
			first: () => locator,
			isVisible: async () => false,
		};
		let error: unknown;
		try {
			await runGoogleLogin({
				page: {
					goto: async () => undefined,
					url: () => urls.password,
					locator: () => locator,
					waitForTimeout: async () => {
						throw new Error(leaked);
					},
				},
				credentials,
				totpCodes: [],
				stateReadyAttempts: 1,
			});
		} catch (caught) {
			error = caught;
		}
		assert.equal(error instanceof BrowserMaintenanceError, true);
		assert.equal((error as { code?: string }).code, "browser_unavailable");
		assert.doesNotMatch(String(error), new RegExp(leaked));
	});

	test("classifies a Chromium error page after submission as navigation failure", async () => {
		const leaked = "net::ERR_PROXY_CONNECTION_FAILED private-proxy-detail";
		const page = scriptedPage(["email"]);
		page.url = () =>
			page.submissions.length
				? `chrome-error://chromewebdata/#${leaked}`
				: urls.email;
		let error: unknown;
		try {
			await runGoogleLogin({ page, credentials, totpCodes: [] });
		} catch (caught) {
			error = caught;
		}
		assert.equal(error instanceof BrowserMaintenanceError, true);
		assert.equal((error as { code?: string }).code, "navigation_failed");
		assert.doesNotMatch(String(error), /ERR_PROXY|private-proxy/i);
	});

	test("redacts Playwright timeout and net error operations", async () => {
		for (const source of [
			Object.assign(new Error("private timeout detail"), {
				name: "TimeoutError",
			}),
			new Error(
				"locator failed: net::ERR_NAME_NOT_RESOLVED private-dns-detail",
			),
		]) {
			const locator = {
				first: () => locator,
				isVisible: async () => {
					throw source;
				},
			};
			const adapter = createPlaywrightPageAdapter({ locator: () => locator });
			let error: unknown;
			try {
				await adapter.visible("email");
			} catch (caught) {
				error = caught;
			}
			assert.equal(error instanceof BrowserMaintenanceError, true);
			assert.equal((error as { code?: string }).code, "browser_unavailable");
			assert.doesNotMatch(String(error), /private|ERR_NAME|timeout detail/i);
		}
	});

	test("observes only visible account email elements", async () => {
		const queried: string[] = [];
		const adapter = createPlaywrightPageAdapter({
			locator: (selector: string) => {
				queried.push(selector);
				const locator = {
					first: () => locator,
					getAttribute: async () =>
						selector.includes(":visible")
							? "current@example.com"
							: "stale@example.com",
				};
				return locator;
			},
		});
		assert.equal(await adapter.observedEmail(), "current@example.com");
		assert.equal(queried[0], "[data-email]:visible");
	});

	test("waits a bounded time for trusted route controls to become ready", async () => {
		let rendered = false;
		let waits = 0;
		let state: State = "password";
		const page = {
			gotoGemini: async () => undefined,
			url: () => urls[state],
			visible: async (candidate: State) => rendered && candidate === state,
			waitForStateReady: async () => {
				waits += 1;
				if (waits === 2) rendered = true;
			},
			fillAndSubmit: async () => {
				state = "authenticated";
			},
			waitForPageChange: async () => "changed",
			cookies: async () => [
				{ name: "__Secure-1PSID", value: "psid-value" },
				{ name: "__Secure-1PSIDTS", value: "psidts-value" },
			],
			observedEmail: async () => "owner@example.com",
		};
		assert.equal(
			(
				await runGoogleLogin({
					page,
					credentials,
					totpCodes: [],
					stateReadyAttempts: 3,
				})
			).ok,
			true,
		);
		assert.equal(waits, 2);

		rendered = false;
		waits = 0;
		state = "password";
		assert.deepEqual(
			await runGoogleLogin({
				page: {
					...page,
					waitForStateReady: async () => {
						waits += 1;
					},
				},
				credentials,
				totpCodes: [],
				stateReadyAttempts: 3,
			}),
			{ ok: false, code: "unknown_page" },
		);
		assert.equal(waits, 3);
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
