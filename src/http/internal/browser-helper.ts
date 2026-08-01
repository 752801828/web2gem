import { SqlBrowserAccountStore } from "../../browser/store";
import { BROWSER_STATES } from "../../browser/types";
import type {
	BrowserAccountStore,
	BrowserState,
	BrowserStatusUpdate,
} from "../../browser/types";
import type { RuntimeConfig, AppEnv } from "../../config";
import {
	getGeminiAccountPoolFromEnv,
	sqlBindingFromEnv,
} from "../../gemini/accounts/runtime";
import { timingSafeStringEqual } from "../../shared/crypto";
import type { UnknownRecord } from "../../shared/types";
import { jsonResponse, readJsonRequest } from "../core/json";

const PATH_PREFIX = "/internal/browser/accounts";
const MAX_BODY_BYTES = 64 * 1024;
const FAILURE_CODE = /^[a-z0-9_]{1,64}$/;

type BrowserHelperErrorCode =
	| "invalid_browser_helper_token"
	| "browser_helper_route_not_found"
	| "invalid_browser_helper_json"
	| "browser_helper_body_too_large"
	| "browser_helper_store_unavailable"
	| "browser_account_not_found"
	| "browser_candidate_invalid"
	| "browser_identity_mismatch"
	| "browser_cookie_verification_failed"
	| "browser_account_restricted"
	| "browser_cookie_conflict"
	| "browser_helper_request_failed";

class BrowserHelperError extends Error {
	constructor(
		readonly status: number,
		readonly code: BrowserHelperErrorCode,
		message: string,
	) {
		super(message);
	}
}

export function isBrowserHelperPath(path: string): boolean {
	return path === PATH_PREFIX || path.startsWith(`${PATH_PREFIX}/`);
}

export async function handleBrowserHelperRequest(
	request: Request,
	env: AppEnv,
	cfg: RuntimeConfig,
	url: URL,
): Promise<Response> {
	if (!browserHelperAuthorized(request, env.BROWSER_HELPER_INTERNAL_TOKEN))
		return errorResponse(
			new BrowserHelperError(
				401,
				"invalid_browser_helper_token",
				"unauthorized",
			),
		);

	try {
		const route = browserHelperRoute(
			request.method.toUpperCase(),
			url.pathname,
		);
		if (!route)
			throw new BrowserHelperError(
				404,
				"browser_helper_route_not_found",
				"browser helper route not found",
			);
		if (url.search) invalidRequest();

		if (route.kind === "list") {
			const accounts = await browserStore(env).listScheduled(Date.now());
			return jsonResponse({
				accounts: accounts.map((account) => ({
					id: account.accountId,
					label: account.label,
					status: {
						...account.status,
						failureCode:
							typeof account.status.failureCode === "string" &&
							FAILURE_CODE.test(account.status.failureCode)
								? account.status.failureCode
								: null,
					},
					authFailureCount: account.authFailureCount,
					autoLoginAttemptDate: account.autoLoginAttemptDate,
					autoLoginAttemptCount: account.autoLoginAttemptCount,
				})),
			});
		}

		const accountId = route.accountId;
		if (route.kind === "credentials") {
			const credentials =
				await browserStore(env).getEncryptedCredentials(accountId);
			if (!credentials)
				throw new BrowserHelperError(
					404,
					"browser_account_not_found",
					"browser account credentials not found",
				);
			return jsonResponse(credentials);
		}

		const body = await readBody(request);
		if (route.kind === "acquireLease") {
			const lease = leaseBody(body, true);
			const nowMs = Date.now();
			const acquired = await browserStore(env).tryAcquireLease(
				accountId,
				lease.owner,
				nowMs + lease.ttlSeconds * 1000,
				nowMs,
			);
			return jsonResponse({ acquired });
		}
		if (route.kind === "releaseLease") {
			const lease = leaseBody(body, false);
			await browserStore(env).releaseLease(accountId, lease.owner);
			return jsonResponse({ released: true });
		}
		if (route.kind === "state") {
			await browserStore(env).writeStatus(accountId, stateBody(body));
			return jsonResponse({ updated: true });
		}

		const candidate = candidateBody(body);
		const service =
			env.BROWSER_CANDIDATE_COOKIE_SERVICE ??
			getGeminiAccountPoolFromEnv(env)?.createCandidateCookieService(cfg);
		if (!service) unavailable();
		const result = await service.replace({
			accountId,
			...candidate,
			nowMs: Date.now(),
		});
		if (!result.ok)
			throw new BrowserHelperError(
				candidateStatus(result.code),
				result.code,
				"browser candidate cookie rejected",
			);
		return jsonResponse({
			changed: result.changed,
			state: result.state,
			lastCookieUpdateAtMs: result.lastCookieUpdateAtMs,
		});
	} catch (error) {
		return errorResponse(error);
	}
}

function browserHelperAuthorized(
	request: Request,
	configured: unknown,
): boolean {
	if (typeof configured !== "string" || !configured) return false;
	const bearer = /^Bearer ([^\s]+)$/.exec(
		request.headers.get("authorization") || "",
	);
	return !!bearer?.[1] && timingSafeStringEqual(bearer[1], configured);
}

type BrowserHelperRoute =
	| { kind: "list" }
	| {
			kind:
				| "acquireLease"
				| "releaseLease"
				| "credentials"
				| "state"
				| "candidateCookie";
			accountId: string;
	  };

function browserHelperRoute(
	method: string,
	path: string,
): BrowserHelperRoute | null {
	if (method === "GET" && path === PATH_PREFIX) return { kind: "list" };
	if (!path.startsWith(`${PATH_PREFIX}/`)) return null;
	const parts = path.slice(PATH_PREFIX.length + 1).split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	let accountId: string;
	try {
		accountId = decodeURIComponent(parts[0]);
	} catch {
		return null;
	}
	if (!accountId || accountId.length > 256 || accountId.includes("/"))
		return null;
	const action = parts[1];
	if (action === "lease" && method === "POST")
		return { kind: "acquireLease", accountId };
	if (action === "lease" && method === "DELETE")
		return { kind: "releaseLease", accountId };
	if (action === "credentials" && method === "GET")
		return { kind: "credentials", accountId };
	if (action === "state" && method === "PATCH")
		return { kind: "state", accountId };
	if (action === "candidate-cookie" && method === "POST")
		return { kind: "candidateCookie", accountId };
	return null;
}

function browserStore(env: AppEnv): BrowserAccountStore {
	if (env.BROWSER_ACCOUNT_STORE) return env.BROWSER_ACCOUNT_STORE;
	const db = sqlBindingFromEnv(env);
	if (!db) unavailable();
	return new SqlBrowserAccountStore(db);
}

async function readBody(request: Request): Promise<UnknownRecord> {
	const parsed = await readJsonRequest(request, {
		maxBodyBytes: MAX_BODY_BYTES,
		oversizedError: {
			status: 413,
			code: "browser_helper_body_too_large",
			message: "browser helper request body is too large",
		},
	});
	if (parsed.error !== undefined)
		throw new BrowserHelperError(
			parsed.status,
			parsed.code === "browser_helper_body_too_large"
				? "browser_helper_body_too_large"
				: "invalid_browser_helper_json",
			parsed.code === "browser_helper_body_too_large"
				? "browser helper request body is too large"
				: "invalid browser helper request",
		);
	return parsed.value;
}

function leaseBody(
	body: UnknownRecord,
	acquire: true,
): { owner: string; ttlSeconds: number };
function leaseBody(body: UnknownRecord, acquire: false): { owner: string };
function leaseBody(body: UnknownRecord, acquire: boolean) {
	const keys = acquire ? ["owner", "ttlSeconds"] : ["owner"];
	if (!exactKeys(body, keys) || !boundedString(body.owner, 128))
		invalidRequest();
	if (!acquire) return { owner: body.owner };
	if (!integerBetween(body.ttlSeconds, 30, 600)) invalidRequest();
	return { owner: body.owner, ttlSeconds: body.ttlSeconds };
}

function stateBody(body: UnknownRecord): BrowserStatusUpdate {
	if (
		!exactKeys(body, [
			"state",
			"lastCheckAtMs",
			"lastCookieUpdateAtMs",
			"lastAutoLoginAtMs",
			"authFailureCount",
			"notificationState",
			"failureCode",
		]) ||
		!isBrowserState(body.state) ||
		!nullableTimestamp(body.lastCheckAtMs) ||
		!nullableTimestamp(body.lastCookieUpdateAtMs) ||
		!nullableTimestamp(body.lastAutoLoginAtMs) ||
		!integerBetween(body.authFailureCount, 0, 1_000_000) ||
		!(
			body.notificationState === null ||
			boundedString(body.notificationState, 64)
		) ||
		!(
			body.failureCode === null ||
			(typeof body.failureCode === "string" &&
				FAILURE_CODE.test(body.failureCode))
		)
	)
		invalidRequest();
	return {
		state: body.state,
		lastCheckAtMs: body.lastCheckAtMs,
		lastCookieUpdateAtMs: body.lastCookieUpdateAtMs,
		lastAutoLoginAtMs: body.lastAutoLoginAtMs,
		authFailureCount: body.authFailureCount,
		notificationState: body.notificationState,
		failureCode: body.failureCode,
		nowMs: Date.now(),
	};
}

function candidateBody(body: UnknownRecord) {
	if (
		!exactKeys(body, ["psid", "psidts", "observedEmail"]) ||
		!boundedString(body.psid, 4096) ||
		!boundedString(body.psidts, 4096) ||
		!(body.observedEmail === null || boundedString(body.observedEmail, 320))
	)
		invalidRequest();
	return {
		psid: body.psid,
		psidts: body.psidts,
		observedEmail: body.observedEmail,
	};
}

function exactKeys(body: UnknownRecord, expected: readonly string[]): boolean {
	const keys = Object.keys(body);
	return (
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(body, key))
	);
}

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function integerBetween(
	value: unknown,
	min: number,
	max: number,
): value is number {
	return (
		Number.isSafeInteger(value) &&
		(value as number) >= min &&
		(value as number) <= max
	);
}

function nullableTimestamp(value: unknown): value is number | null {
	return value === null || integerBetween(value, 0, Number.MAX_SAFE_INTEGER);
}

function isBrowserState(value: unknown): value is BrowserState {
	return (
		typeof value === "string" &&
		(BROWSER_STATES as readonly string[]).includes(value)
	);
}

function candidateStatus(code: string): number {
	if (code === "browser_account_not_found") return 404;
	if (code === "browser_cookie_conflict") return 409;
	if (code === "browser_cookie_verification_failed") return 502;
	return 400;
}

function invalidRequest(): never {
	throw new BrowserHelperError(
		400,
		"invalid_browser_helper_json",
		"invalid browser helper request",
	);
}

function unavailable(): never {
	throw new BrowserHelperError(
		503,
		"browser_helper_store_unavailable",
		"browser helper store unavailable",
	);
}

function errorResponse(error: unknown): Response {
	if (error instanceof BrowserHelperError)
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	return jsonResponse(
		{
			error: {
				code: "browser_helper_request_failed",
				message: "browser helper request failed",
			},
		},
		500,
	);
}
