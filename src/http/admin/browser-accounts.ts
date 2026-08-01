import { validateBrowserCredentials } from "../../browser/credentials";
import { SqlBrowserAccountStore } from "../../browser/store";
import type {
	BrowserAccountStatus,
	BrowserAccountStore,
	BrowserCredentials,
} from "../../browser/types";
import type { AppEnv, RuntimeConfig } from "../../config";
import { accountIdFromPathSegment } from "../../gemini/accounts/admin-input";
import { GeminiAccountAdminError } from "../../gemini/accounts/admin";
import { sqlBindingFromEnv } from "../../gemini/accounts/runtime";
import { isRecord } from "../../shared/types";
import { jsonResponse } from "../core/json";
import {
	adminAuthorized,
	adminErrorResponse,
	assertAdminBodyAbsent,
	readAdminJson,
} from "./gemini-accounts";

const ACCOUNT_PREFIX = "/admin/accounts/";
const STOP_PATH = "/admin/browser/stop";
const BROWSER_ACTIONS = new Set(["credentials", "check", "open", "profile"]);
const SAFE_FAILURE_CODE = /^[a-z0-9_]{1,64}$/;

type BrowserAdminRoute =
	| { kind: "stop" }
	| {
			kind: "credentials" | "check" | "open" | "profile";
			accountId: string;
	  };

export function isBrowserAccountAdminPath(path: string): boolean {
	if (path === STOP_PATH) return true;
	if (!path.startsWith(ACCOUNT_PREFIX)) return false;
	const segments = path.slice(ACCOUNT_PREFIX.length).split("/");
	return (
		segments.length === 3 &&
		!!segments[0] &&
		segments[1] === "browser" &&
		!!segments[2] &&
		BROWSER_ACTIONS.has(segments[2])
	);
}

export async function handleBrowserAccountAdminRequest(
	request: Request,
	env: AppEnv,
	cfg: RuntimeConfig,
	url: URL,
): Promise<Response> {
	const auth = adminAuthorized(request, cfg);
	if (!auth.ok)
		return adminErrorResponse(
			new GeminiAccountAdminError(401, auth.code, auth.message),
		);

	try {
		if (url.search) invalid("admin query parameters are not allowed");
		const route = browserAdminRoute(url.pathname);
		if (!route) notFound();
		const method = request.method.toUpperCase();

		if (route.kind === "stop") {
			if (method !== "POST") notFound();
			assertAdminBodyAbsent(request);
			await helperClient(env).stopVisible();
			return jsonResponse({ stopped: true });
		}

		const accountId = route.accountId;
		if (route.kind === "credentials" && method === "PUT")
			return await configureCredentials(request, env, accountId);
		if (route.kind === "credentials" && method === "DELETE") {
			assertAdminBodyAbsent(request);
			requireCredentialCrypto(env);
			const store = browserStore(env);
			await store.clearCredentials(accountId, Date.now());
			return await statusResponse(store, accountId);
		}
		if (route.kind === "check" && method === "POST") {
			assertAdminBodyAbsent(request);
			await helperClient(env).checkNow(accountId);
			return await statusResponse(browserStore(env), accountId);
		}
		if (route.kind === "open" && method === "POST") {
			assertAdminBodyAbsent(request);
			const opened = await helperClient(env).openVisible(accountId);
			return jsonResponse({ url: opened.url });
		}
		if (route.kind === "profile" && method === "DELETE") {
			const body = await readAdminJson(request);
			if (
				!exactKeys(body, ["confirmAccountId"]) ||
				body.confirmAccountId !== accountId
			)
				invalid("profile deletion confirmation does not match account");
			await helperClient(env).deleteProfile(accountId);
			return jsonResponse({ deleted: true });
		}
		notFound();
	} catch (error) {
		return adminErrorResponse(normalizeError(error));
	}
}

async function configureCredentials(
	request: Request,
	env: AppEnv,
	accountId: string,
): Promise<Response> {
	const crypto = requireCredentialCrypto(env);
	const body = await readAdminJson(request);
	if (
		!exactKeys(body, ["email", "password", "totpSecret"]) ||
		typeof body.email !== "string" ||
		typeof body.password !== "string" ||
		typeof body.totpSecret !== "string"
	)
		invalid("browser credentials are invalid");

	const requested = body as BrowserCredentials;
	let decrypted: BrowserCredentials | null = null;
	let merged: BrowserCredentials | null = null;
	try {
		const store = browserStore(env);
		const existing = await store.getEncryptedCredentials(accountId);
		if (existing) decrypted = await crypto.decrypt(accountId, existing);
		merged = validateBrowserCredentials({
			email: requested.email || decrypted?.email || "",
			password: requested.password || decrypted?.password || "",
			totpSecret: requested.totpSecret || decrypted?.totpSecret || "",
		});
		const encrypted = await crypto.encrypt(accountId, merged);
		await store.putCredentials(accountId, encrypted, Date.now());
		return statusResponse(store, accountId);
	} catch (error) {
		if (error instanceof TypeError) invalid("browser credentials are invalid");
		throw error;
	} finally {
		wipe(requested);
		if (decrypted) wipe(decrypted);
		if (merged) wipe(merged);
	}
}

function browserAdminRoute(path: string): BrowserAdminRoute | null {
	if (path === STOP_PATH) return { kind: "stop" };
	if (!path.startsWith(ACCOUNT_PREFIX)) return null;
	const segments = path.slice(ACCOUNT_PREFIX.length).split("/");
	if (
		segments.length !== 3 ||
		!segments[0] ||
		segments[1] !== "browser" ||
		!segments[2]
	)
		return null;
	const action = segments[2];
	if (!BROWSER_ACTIONS.has(action)) return null;
	return {
		kind: action as "credentials" | "check" | "open" | "profile",
		accountId: accountIdFromPathSegment(segments[0]),
	};
}

function browserStore(env: AppEnv): BrowserAccountStore {
	if (env.BROWSER_ACCOUNT_STORE) return env.BROWSER_ACCOUNT_STORE;
	const binding = sqlBindingFromEnv(env);
	if (!binding)
		throw new GeminiAccountAdminError(
			503,
			"browser_store_unavailable",
			"browser account store is unavailable",
		);
	return new SqlBrowserAccountStore(binding);
}

function helperClient(env: AppEnv) {
	if (env.BROWSER_HELPER_CLIENT) return env.BROWSER_HELPER_CLIENT;
	throw new GeminiAccountAdminError(
		503,
		"browser_helper_unavailable",
		"browser helper is unavailable",
	);
}

function requireCredentialCrypto(env: AppEnv) {
	if (env.BROWSER_CREDENTIAL_CRYPTO) return env.BROWSER_CREDENTIAL_CRYPTO;
	throw new GeminiAccountAdminError(
		503,
		"browser_master_key_unavailable",
		"browser credential master key is unavailable",
	);
}

async function statusResponse(store: BrowserAccountStore, accountId: string) {
	const status = await store.getStatus(accountId);
	if (!status)
		throw new GeminiAccountAdminError(
			404,
			"browser_account_not_found",
			"browser account was not found",
		);
	return jsonResponse({
		credentialsConfigured: status.credentialsConfigured,
		status: safeStatus(status),
	});
}

function safeStatus(status: BrowserAccountStatus) {
	return {
		state: status.state,
		lastCheckAtMs: status.lastCheckAtMs,
		lastCookieUpdateAtMs: status.lastCookieUpdateAtMs,
		lastAutoLoginAtMs: status.lastAutoLoginAtMs,
		failureCode:
			typeof status.failureCode === "string" &&
			SAFE_FAILURE_CODE.test(status.failureCode)
				? status.failureCode
				: null,
	};
}

function normalizeError(error: unknown): unknown {
	if (error instanceof GeminiAccountAdminError) return error;
	if (
		isRecord(error) &&
		Number.isInteger(error.status) &&
		typeof error.code === "string" &&
		SAFE_FAILURE_CODE.test(error.code)
	)
		return new GeminiAccountAdminError(
			error.status as number,
			error.code,
			"browser helper request failed",
		);
	return error;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
	const actual = Object.keys(value);
	return (
		actual.length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function wipe(credentials: BrowserCredentials) {
	credentials.email = "";
	credentials.password = "";
	credentials.totpSecret = "";
}

function invalid(message: string): never {
	throw new GeminiAccountAdminError(
		400,
		"invalid_browser_admin_request",
		message,
	);
}

function notFound(): never {
	throw new GeminiAccountAdminError(
		404,
		"admin_route_not_found",
		"admin route not found",
	);
}
