import { totpCandidates } from "./crypto.mjs";

const GEMINI_URL = "https://gemini.google.com/app";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

export async function classifyGooglePage(page) {
	const adapter = asAdapter(page);
	const url = safeUrl(adapter.url());
	const routeState = stateFromUrl(url);
	if (routeState) return routeState;
	if (url?.hostname === "accounts.google.com") {
		for (const state of CHALLENGES)
			if (await adapter.visible(state)) return state;
		for (const state of ["email", "password", "totp"])
			if (await adapter.visible(state)) return state;
	}
	if (
		url?.hostname === "gemini.google.com" &&
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
}) {
	const adapter = asAdapter(page);
	let automaticLoginUsed = false;
	let lastState = null;
	let submittedState = null;
	let codes;
	try {
		await adapter.gotoGemini();
		for (let transitions = 0; transitions < 16; transitions += 1) {
			const state = await classifyGooglePage(adapter);
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
				await adapter.waitForPageChange();
				continue;
			}

			if (!codes) codes = loginTotpCodes(credentials, totpCodes, nowSeconds, serverDate);
			const code = codes.shift();
			if (!code) return { ok: false, code: "login_failed" };
			automaticLoginUsed = true;
			await adapter.fillAndSubmit("totp", code);
			await adapter.waitForPageChange();
		}
	} catch {
		return { ok: false, code: "login_failed" };
	}
	return { ok: false, code: "login_failed" };
}

export function createPlaywrightPageAdapter(page) {
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
		async fillAndSubmit(state, value) {
			const control = page.locator(SELECTORS[state]).first();
			await control.fill(value);
			await control.press("Enter");
		},
		waitForPageChange: () => page.waitForTimeout(1_000),
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
	const hostname = url.hostname.toLowerCase();
	const value = url.pathname.toLowerCase();
	if (hostname === "www.google.com" && /\/sorry(?:\/|$)/.test(value))
		return "captcha";
	if (hostname !== "accounts.google.com") return null;
	if (/captcha|recaptcha/.test(value)) return "captcha";
	if (/\/challenge\/pk(?:\/|$)|passkey|webauthn/.test(value)) return "passkey";
	if (/\/challenge\/(?:ipp|phone|sms)(?:\/|$)/.test(value))
		return "phone_approval";
	if (/\/challenge\/(?:recovery|kpe)(?:\/|$)/.test(value)) return "recovery";
	if (/\/challenge\/(?:dp|device)(?:\/|$)/.test(value))
		return "device_confirmation";
	return null;
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
