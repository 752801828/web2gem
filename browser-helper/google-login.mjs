import { totpCandidates } from "./crypto.mjs";

const GEMINI_URL = "https://gemini.google.com/app";
const GEMINI_ORIGIN = "https://gemini.google.com";
const ACCOUNTS_ORIGIN = "https://accounts.google.com";
const GOOGLE_ORIGIN = "https://www.google.com";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRUCTURED_ERROR_SELECTOR = "[data-error-code]";
const CHALLENGES = [
	"captcha",
	"passkey",
	"phone_approval",
	"recovery",
	"device_confirmation",
];
const SELECTORS = {
	authenticated:
		'[data-email], a[href*="SignOutOptions"], button[aria-label*="@"]',
	email: 'input[type="email"], input[name="identifier"], #identifierId',
	password: 'input[type="password"], input[name="Passwd"]',
	totp: 'input[name="totpPin"], input[autocomplete="one-time-code"]',
	captcha: 'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]',
	passkey: '[data-challengetype="13"], [aria-label*="passkey" i]',
	phone_approval:
		'[data-challengetype="12"], [data-challengetype="39"], [aria-label*="phone" i]',
	recovery:
		'[data-challengetype="2"], [data-challengetype="5"], [aria-label*="recovery" i]',
	device_confirmation:
		'[data-challengetype="4"], [data-challengetype="33"], [aria-label*="device" i]',
};

export class BrowserMaintenanceError extends Error {
	constructor(code) {
		super("browser maintenance failed");
		this.name = "BrowserMaintenanceError";
		this.code = code;
	}
}

export async function classifyGooglePage(page) {
	const adapter = asAdapter(page);
	const url = safeUrl(adapter.url());
	if (url?.protocol === "chrome-error:")
		throw new BrowserMaintenanceError("navigation_failed");
	const routeState = stateFromUrl(url);
	if (
		routeState &&
		routeState !== "unknown" &&
		!["email", "password", "totp"].includes(routeState)
	)
		return routeState;
	if (routeState) {
		for (const challenge of CHALLENGES)
			if (await adapter.visible(challenge)) return challenge;
		if (await adapter.visible(routeState)) return routeState;
	}
	if (url?.origin === GEMINI_ORIGIN && (await adapter.visible("authenticated")))
		return "authenticated";
	if (await adapter.sessionAuthenticated?.())
		return "authenticated";
	return "unknown";
}

export async function waitForGoogleAuthentication(
	page,
	signal,
	{ pollMs = 1_000, wait = abortableDelay } = {},
) {
	for (;;) {
		throwIfAborted(signal);
		try {
			if ((await classifyGooglePage(page)) === "authenticated") return;
		} catch {
			// Navigation can briefly invalidate page handles between trusted screens.
		}
		await wait(pollMs, signal);
	}
}

export async function runGoogleLogin({
	page,
	credentials,
	totpCodes,
	nowSeconds = Math.floor(Date.now() / 1_000),
	serverDate,
	maxClockSkewSec = 120,
	stateReadyAttempts = 20,
	beforeSubmit,
	identityEmail,
}) {
	const adapter = asAdapter(page);
	let automaticLoginUsed = false;
	let lastState = null;
	let submittedState = null;
	let codes;
	let loginPreflightDone = false;
	const preflightLogin = () => {
		if (loginPreflightDone) return;
		codes = loginTotpCodes(
			credentials,
			totpCodes,
			nowSeconds,
			serverDate,
			maxClockSkewSec,
		);
		loginPreflightDone = true;
	};
	let submissionReserved = false;
	const reserveSubmission = async () => {
		if (submissionReserved) return;
		if (beforeSubmit !== undefined) {
			if (typeof beforeSubmit !== "function")
				throw new BrowserMaintenanceError("browser_unavailable");
			await beforeSubmit();
		}
		submissionReserved = true;
	};
	try {
		await adapter.gotoGemini();
	} catch {
		throw new BrowserMaintenanceError("navigation_failed");
	}
	try {
		for (let transitions = 0; transitions < 16; transitions += 1) {
			const state = await readyGoogleState(adapter, stateReadyAttempts);
			if (CHALLENGES.includes(state)) return { ok: false, code: state };
			if (state === "unknown") return { ok: false, code: "unknown_page" };
			if (state === "authenticated")
				return await finishAuthenticated(
					adapter,
					automaticLoginUsed,
					identityEmail,
				);

			if (state !== lastState) submittedState = null;
			lastState = state;
			if (state === "email" || state === "password") {
				if (submittedState === state)
					return { ok: false, code: "login_failed" };
				const value = credentials?.[state];
				if (typeof value !== "string" || !value)
					return { ok: false, code: "login_failed" };
				preflightLogin();
				submittedState = state;
				automaticLoginUsed = true;
				await adapter.fillAndSubmit(state, value, reserveSubmission);
				const outcome = await adapter.waitForPageChange(state);
				if (outcome !== "changed")
					return { ok: false, code: "login_failed" };
				continue;
			}

			preflightLogin();
			const code = codes.shift();
			if (!code) return { ok: false, code: "login_failed" };
			automaticLoginUsed = true;
			await adapter.fillAndSubmit("totp", code, reserveSubmission);
			const outcome = await adapter.waitForPageChange("totp");
			if (outcome === "timeout") return { ok: false, code: "login_failed" };
			if (outcome !== "changed" && outcome !== "rejected")
				return { ok: false, code: "login_failed" };
		}
	} catch (error) {
		if (error instanceof BrowserMaintenanceError) throw error;
		return { ok: false, code: "login_failed" };
	}
	return { ok: false, code: "login_failed" };
}

export function createPlaywrightPageAdapter(
	page,
	{ submissionPolls = 100, submissionPollMs = 100 } = {},
) {
	let submission = null;
	return {
		url: () => page.url(),
		async visible(state) {
			const selector = SELECTORS[state];
			if (!selector) return false;
			try {
				return await page.locator(selector).first().isVisible();
			} catch (error) {
				const maintenance = pageMaintenanceError(error);
				if (maintenance) throw maintenance;
				return false;
			}
		},
		gotoGemini: () => page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" }),
		async waitForStateReady() {
			try {
				await page.waitForTimeout(250);
			} catch {
				throw new BrowserMaintenanceError("browser_unavailable");
			}
		},
		async fillAndSubmit(state, value, beforeSubmit) {
			if (submission)
				throw new Error("browser form submission state is invalid");
			const initialUrl = trustedSubmissionUrl(page.url(), state);
			let control;
			try {
				control = await page.locator(SELECTORS[state]).first().elementHandle();
			} catch (error) {
				const maintenance = pageMaintenanceError(error);
				if (maintenance) throw maintenance;
				throw untrustedSubmission();
			}
			if (!control) throw untrustedSubmission();
			try {
				trustedSubmissionUrl(page.url(), state);
				const formAction = await control.evaluate(
					(element) => element.form?.action ?? "",
				);
				if (
					formAction &&
					safeUrl(new URL(formAction, initialUrl).href)?.origin !== ACCOUNTS_ORIGIN
				)
					throw untrustedSubmission();
				if (!(await control.isVisible())) throw untrustedSubmission();
				await control.fill(value);
				trustedSubmissionUrl(page.url(), state);
				if (!(await control.evaluate((element) => element.isConnected)))
					throw untrustedSubmission();
				submission = {
					state,
					url: initialUrl,
					control,
					visibleStates: await semanticVisibility(page),
					rejection:
						state === "totp"
							? await structuredRejectionBaseline(control)
							: { error: null, watch: null },
				};
				await beforeSubmit?.();
				await control.press("Enter");
			} catch (error) {
				const maintenance = pageMaintenanceError(error);
				if (submission?.control === control) {
					const failed = submission;
					submission = null;
					await disposeSubmission(failed);
				} else await control.dispose().catch(() => undefined);
				if (maintenance) throw maintenance;
				throw untrustedSubmission();
			}
		},
		async waitForPageChange(state) {
			if (!submission || submission.state !== state)
				throw new Error("browser form submission state is invalid");
			const active = submission;
			try {
				for (let attempt = 0; attempt < submissionPolls; attempt += 1) {
					if (page.url() !== active.url) return "changed";
					const visibleStates = await semanticVisibility(page);
					if (!sameVisibility(active.visibleStates, visibleStates)) return "changed";
					if (
						state === "totp" &&
						(await structuredRejectionChanged(active.control, active.rejection))
					)
						return "rejected";
					await page.waitForTimeout(submissionPollMs);
				}
				return "timeout";
			} catch (error) {
				if (page.url() !== active.url) return "changed";
				const maintenance = pageMaintenanceError(error);
				if (maintenance) throw maintenance;
				throw error;
			} finally {
				await disposeSubmission(active);
				if (submission === active) submission = null;
			}
		},
		async cookies() {
			try {
				return (await page.context().cookies()).filter((cookie) => {
					const domain = String(cookie?.domain || "").toLowerCase();
					return domain === "google.com" || domain.endsWith(".google.com");
				});
			} catch {
				throw new BrowserMaintenanceError("browser_unavailable");
			}
		},
		async sessionAuthenticated() {
			const cookies = await this.cookies();
			return Boolean(
				cookieValue(cookies, "__Secure-1PSID") &&
					cookieValue(cookies, "__Secure-1PSIDTS"),
			);
		},
		async observedEmail() {
			const dataEmail = await optionalAttribute(
				page.locator("[data-email]:visible").first(),
				"data-email",
			);
			if (reliableEmail(dataEmail)) return dataEmail.trim().toLowerCase();
			const label = await optionalAttribute(
				page.locator('[aria-label*="@"]:visible').first(),
				"aria-label",
			);
			return label?.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
		},
	};
}

function asAdapter(page) {
	return typeof page?.visible === "function"
		? page
		: createPlaywrightPageAdapter(page);
}

function safeUrl(value) {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

function stateFromUrl(url) {
	if (!url) return null;
	const value = url.pathname.toLowerCase();
	if (url.origin === GOOGLE_ORIGIN && /\/sorry(?:\/|$)/.test(value))
		return "captcha";
	if (url.origin !== ACCOUNTS_ORIGIN) return null;
	if (/captcha|recaptcha/.test(value)) return "captcha";
	if (/\/challenge\/pk(?:\/|$)|passkey|webauthn/.test(value)) return "passkey";
	if (/\/challenge\/(?:ipp|phone|sms)(?:\/|$)/.test(value))
		return "phone_approval";
	if (/\/challenge\/(?:recovery|kpe)(?:\/|$)/.test(value)) return "recovery";
	if (/\/challenge\/(?:dp|device)(?:\/|$)/.test(value))
		return "device_confirmation";
	if (/\/challenge\/pwd(?:\/|$)/.test(value)) return "password";
	if (/\/challenge\/totp(?:\/|$)/.test(value)) return "totp";
	if (value.includes("/challenge/")) return "unknown";
	if (/\/signin\/identifier(?:\/|$)/.test(value)) return "email";
	return null;
}

async function readyGoogleState(adapter, attempts) {
	if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > 40)
		return "unknown";
	for (let attempt = 0; ; attempt += 1) {
		const state = await classifyGooglePage(adapter);
		if (state !== "unknown" || !isTrustedPendingUrl(adapter.url())) return state;
		if (attempt >= attempts) return "unknown";
		await adapter.waitForStateReady();
	}
}

function isTrustedPendingUrl(value) {
	const url = safeUrl(value);
	if (url?.origin === GEMINI_ORIGIN) return true;
	return ["email", "password", "totp"].includes(stateFromUrl(url));
}

function loginTotpCodes(
	credentials,
	supplied,
	nowSeconds,
	serverDate,
	maxClockSkewSec,
) {
	let candidates = supplied;
	if (candidates === undefined) {
		try {
			const generated = totpCandidates(credentials?.totpSecret, nowSeconds, {
				serverDate,
				maxClockSkewSec,
			});
			candidates = [generated[1], generated[0], generated[2]];
		} catch {
			if (clockSkewed(nowSeconds, serverDate, maxClockSkewSec))
				throw new BrowserMaintenanceError("clock_skew");
			throw new Error("TOTP generation failed");
		}
	}
	if (!Array.isArray(candidates)) return [];
	return [...new Set(candidates)].filter(
		(code) => typeof code === "string" && /^\d{6}$/.test(code),
	).slice(0, 3);
}

function clockSkewed(nowSeconds, serverDate, maxClockSkewSec) {
	const serverMs = Date.parse(serverDate);
	return (
		Number.isFinite(serverMs) &&
		Number.isSafeInteger(maxClockSkewSec) &&
		Math.abs(nowSeconds - serverMs / 1_000) > maxClockSkewSec
	);
}

function abortableDelay(ms, signal) {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", aborted);
			resolve();
		}, ms);
		const aborted = () => {
			clearTimeout(timer);
			reject(abortReason(signal));
		};
		signal?.addEventListener("abort", aborted, { once: true });
	});
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
	return signal?.reason instanceof Error
		? signal.reason
		: new Error("authentication observation aborted");
}

async function finishAuthenticated(adapter, automaticLoginUsed, identityEmail) {
	const cookies = await adapter.cookies();
	const psid = cookieValue(cookies, "__Secure-1PSID");
	const psidts = cookieValue(cookies, "__Secure-1PSIDTS");
	if (!psid || !psidts) return { ok: false, code: "missing_cookie" };
	const observed = reliableEmail(identityEmail)
		? identityEmail
		: await adapter.observedEmail();
	if (!reliableEmail(observed)) return { ok: false, code: "login_failed" };
	return {
		ok: true,
		psid,
		psidts,
		observedEmail: observed.trim().toLowerCase(),
		automaticLoginUsed,
	};
}

function cookieValue(cookies, name) {
	const value = Array.isArray(cookies)
		? cookies.find((cookie) => cookie?.name === name)?.value
		: undefined;
	return typeof value === "string" && value ? value : null;
}

function reliableEmail(value) {
	return typeof value === "string" && value.length <= 320 && EMAIL_PATTERN.test(value.trim());
}

async function semanticVisibility(page) {
	return Object.fromEntries(
		await Promise.all(
			Object.entries(SELECTORS).map(async ([state, selector]) => {
				try {
					return [state, await page.locator(selector).first().isVisible()];
				} catch (error) {
					const maintenance = pageMaintenanceError(error);
					if (maintenance) throw maintenance;
					return [state, false];
				}
			}),
		),
	);
}

async function optionalAttribute(locator, name) {
	try {
		return await locator.getAttribute(name);
	} catch (error) {
		const maintenance = pageMaintenanceError(error);
		if (maintenance) throw maintenance;
		return null;
	}
}

function pageMaintenanceError(error) {
	if (error instanceof BrowserMaintenanceError) return error;
	const message = error instanceof Error ? error.message : "";
	return error?.name === "TimeoutError" ||
		/net::ERR_[A-Z_]+/i.test(message) ||
		/(?:target|page|context|browser).*(?:closed|crash|disconnect)|(?:closed|crash|disconnect).*(?:target|page|context|browser)/i.test(
			message,
		)
		? new BrowserMaintenanceError("browser_unavailable")
		: null;
}

function trustedSubmissionUrl(value, state) {
	const url = safeUrl(value);
	if (url?.origin !== ACCOUNTS_ORIGIN || stateFromUrl(url) !== state)
		throw untrustedSubmission();
	return url.href;
}

function untrustedSubmission() {
	return new Error("browser submission is not trusted");
}

function sameVisibility(left, right) {
	return Object.keys(SELECTORS).every(
		(state) => Boolean(left[state]) === Boolean(right[state]),
	);
}

async function structuredRejectionBaseline(control) {
	let error = null;
	let watch = null;
	try {
		error = await submissionErrorElement(control);
		watch = await installStructuredRejectionWatch(control);
		return {
			ariaInvalid: await control.getAttribute("aria-invalid"),
			error,
			watch,
			errorVisible: error ? await error.isVisible().catch(() => false) : false,
			errorCode: error
				? await error.getAttribute("data-error-code").catch(() => null)
				: null,
		};
	} catch (error_) {
		await disposeRejection({ error, watch });
		throw error_;
	}
}

async function structuredRejectionChanged(control, baseline) {
	if (
		baseline.watch &&
		(await baseline.watch.evaluate((watch) => watch.state.generation > 0))
	)
		return true;
	const ariaInvalid = await control.getAttribute("aria-invalid");
	if (baseline.ariaInvalid !== "true" && ariaInvalid === "true") return true;
	const current = await submissionErrorElement(control);
	if (!current) return false;
	try {
		if (!(await current.isVisible().catch(() => false))) return false;
		if (!baseline.error) return true;
		let same = false;
		try {
			same = await current.evaluate(
				(element, previous) => element === previous,
				baseline.error,
			);
		} catch {
			same = false;
		}
		if (!same || !baseline.errorVisible) return true;
		const code = await current
			.getAttribute("data-error-code")
			.catch(() => null);
		return Boolean(code && code !== baseline.errorCode);
	} finally {
		await current.dispose().catch(() => undefined);
	}
}

async function submissionErrorElement(control) {
	const handle = await control.evaluateHandle(
		(element, selector) => {
			const described = (element.getAttribute("aria-describedby") ?? "")
				.split(/\s+/)
				.filter(Boolean)
				.map((id) => document.getElementById(id));
			return (
				described.find(Boolean) ?? element.form?.querySelector(selector) ?? null
			);
		},
		STRUCTURED_ERROR_SELECTOR,
	);
	const element = handle.asElement();
	if (element) return element;
	await handle.dispose();
	return null;
}

async function installStructuredRejectionWatch(control) {
	return control.evaluateHandle((element, selector) => {
		const described = (element.getAttribute("aria-describedby") ?? "")
			.split(/\s+/)
			.filter(Boolean)
			.map((id) => document.getElementById(id));
		const error =
			described.find(Boolean) ?? element.form?.querySelector(selector) ?? null;
		const state = { generation: 0, cleared: false };
		const visible = (candidate) =>
			Boolean(
				candidate &&
				candidate.getClientRects().length > 0 &&
				candidate.getAttribute("aria-hidden") !== "true",
			);
		const explicitError = () =>
			Boolean(
				visible(error) &&
				(error.getAttribute("data-error-code") || error.textContent?.trim()),
			);
		const observer = new MutationObserver((records) => {
			const ariaRejected = element.getAttribute("aria-invalid") === "true";
			const errorRejected = explicitError();
			const rejectionMutation = records.some((record) => {
				if (record.target === element)
					return record.attributeName === "aria-invalid" && ariaRejected;
				if (!error || !error.contains(record.target)) return false;
				if (record.type === "characterData" || record.type === "childList")
					return errorRejected;
				if (record.attributeName === "data-error-code")
					return Boolean(error.getAttribute("data-error-code"));
				return state.cleared && errorRejected;
			});
			if (rejectionMutation) {
				state.generation += 1;
				state.cleared = false;
			} else if (!ariaRejected && !errorRejected) state.cleared = true;
		});
		observer.observe(element, {
			attributes: true,
			attributeFilter: ["aria-invalid"],
		});
		if (error)
			observer.observe(error, {
				subtree: true,
				childList: true,
				characterData: true,
				attributes: true,
				attributeFilter: [
					"data-error-code",
					"hidden",
					"style",
					"class",
					"aria-hidden",
				],
			});
		return { observer, state };
	}, STRUCTURED_ERROR_SELECTOR);
}

async function disposeSubmission(submission) {
	await disposeRejection(submission.rejection);
	await submission.control.dispose().catch(() => undefined);
}

async function disposeRejection(rejection) {
	if (rejection.watch) {
		await rejection.watch
			.evaluate((watch) => watch.observer.disconnect())
			.catch(() => undefined);
		await rejection.watch.dispose().catch(() => undefined);
	}
	await rejection.error?.dispose().catch(() => undefined);
}
