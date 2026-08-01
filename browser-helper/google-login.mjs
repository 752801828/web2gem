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
		super("browser maintenance navigation failed");
		this.name = "BrowserMaintenanceError";
		this.code = code;
	}
}

export async function classifyGooglePage(page) {
	const adapter = asAdapter(page);
	const url = safeUrl(adapter.url());
	const routeState = stateFromUrl(url);
	if (routeState && !["email", "password", "totp"].includes(routeState))
		return routeState;
	if (routeState) {
		for (const challenge of CHALLENGES)
			if (await adapter.visible(challenge)) return challenge;
		if (await adapter.visible(routeState)) return routeState;
	}
	if (
		url?.origin === GEMINI_ORIGIN &&
		(await adapter.visible("authenticated"))
	)
		return "authenticated";
	return "unknown";
}

export async function runGoogleLogin({
	page,
	credentials,
	totpCodes,
	nowSeconds = Math.floor(Date.now() / 1_000),
	serverDate,
	stateReadyAttempts = 20,
}) {
	const adapter = asAdapter(page);
	let automaticLoginUsed = false;
	let lastState = null;
	let submittedState = null;
	let codes;
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
				return await finishAuthenticated(adapter, automaticLoginUsed);

			if (state !== lastState) submittedState = null;
			lastState = state;
			if (state === "email" || state === "password") {
				if (submittedState === state)
					return { ok: false, code: "login_failed" };
				const value = credentials?.[state];
				if (typeof value !== "string" || !value)
					return { ok: false, code: "login_failed" };
				submittedState = state;
				automaticLoginUsed = true;
				await adapter.fillAndSubmit(state, value);
				const outcome = await adapter.waitForPageChange(state);
				if (outcome !== "changed")
					return { ok: false, code: "login_failed" };
				continue;
			}

			if (!codes) codes = loginTotpCodes(credentials, totpCodes, nowSeconds, serverDate);
			const code = codes.shift();
			if (!code) return { ok: false, code: "login_failed" };
			automaticLoginUsed = true;
			await adapter.fillAndSubmit("totp", code);
			const outcome = await adapter.waitForPageChange("totp");
			if (outcome === "timeout") return { ok: false, code: "login_failed" };
			if (outcome !== "changed" && outcome !== "rejected")
				return { ok: false, code: "login_failed" };
		}
	} catch {
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
			return page
				.locator(selector)
				.first()
				.isVisible()
				.catch(() => false);
		},
		gotoGemini: () => page.goto(GEMINI_URL, { waitUntil: "domcontentloaded" }),
		waitForStateReady: () => page.waitForTimeout(250),
		async fillAndSubmit(state, value) {
			if (submission)
				throw new Error("browser form submission state is invalid");
			const initialUrl = trustedSubmissionUrl(page.url(), state);
			const control = await page.locator(SELECTORS[state]).first().elementHandle();
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
							: { error: null },
				};
				await control.press("Enter");
			} catch {
				if (submission?.control === control) {
					const failed = submission;
					submission = null;
					await disposeSubmission(failed);
				} else await control.dispose().catch(() => undefined);
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
				throw error;
			} finally {
				await disposeSubmission(active);
				if (submission === active) submission = null;
			}
		},
		cookies: () => page.context().cookies("https://gemini.google.com"),
		async observedEmail() {
			const dataEmail = await page
				.locator("[data-email]")
				.first()
				.getAttribute("data-email")
				.catch(() => null);
			if (reliableEmail(dataEmail)) return dataEmail.trim().toLowerCase();
			const label = await page
				.locator('[aria-label*="@"]')
				.first()
				.getAttribute("aria-label")
				.catch(() => null);
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

function loginTotpCodes(credentials, supplied, nowSeconds, serverDate) {
	const candidates = supplied ??
		(() => {
			const generated = totpCandidates(credentials?.totpSecret, nowSeconds, {
				serverDate,
			});
			return [generated[1], generated[0], generated[2]];
		})();
	if (!Array.isArray(candidates)) return [];
	return [...new Set(candidates)].filter(
		(code) => typeof code === "string" && /^\d{6}$/.test(code),
	).slice(0, 3);
}

async function finishAuthenticated(adapter, automaticLoginUsed) {
	const cookies = await adapter.cookies();
	const psid = cookieValue(cookies, "__Secure-1PSID");
	const psidts = cookieValue(cookies, "__Secure-1PSIDTS");
	if (!psid || !psidts) return { ok: false, code: "missing_cookie" };
	const observed = await adapter.observedEmail();
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
			Object.entries(SELECTORS).map(async ([state, selector]) => [
				state,
				await page
					.locator(selector)
					.first()
					.isVisible()
					.catch(() => false),
			]),
		),
	);
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
	const error = await submissionErrorElement(control);
	return {
		ariaInvalid: await control.getAttribute("aria-invalid"),
		error,
		errorVisible: error ? await error.isVisible().catch(() => false) : false,
		errorCode: error
			? await error.getAttribute("data-error-code").catch(() => null)
			: null,
	};
}

async function structuredRejectionChanged(control, baseline) {
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

async function disposeSubmission(submission) {
	await submission.rejection.error?.dispose().catch(() => undefined);
	await submission.control.dispose().catch(() => undefined);
}
