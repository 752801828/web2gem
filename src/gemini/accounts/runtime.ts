import type { WorkerEnv } from "../../config";
import { fetchGoogleCookieRotation } from "../cookies";
import { AccountPoolService } from "./pool";
import { verifyGeminiAccount } from "./probe";
import type { GeminiAccountPoolOptions } from "./pool";
import type { D1DatabaseLike } from "./types";
import { D1GeminiAccountStore } from "./store-d1";

const DEFAULT_POOL_BY_DB = new WeakMap<D1DatabaseLike, AccountPoolService>();

function createGeminiAccountPoolFromEnv(
	env: WorkerEnv | null | undefined,
	options: GeminiAccountPoolOptions = {},
): AccountPoolService | null {
	const db = d1BindingFromEnv(env);
	if (!db) return null;
	const rotateCookie =
		options.rotateCookie ||
		((input) =>
			fetchGoogleCookieRotation(input.config, input.account.cookie_header));
	const verifyAccount = options.verifyAccount || verifyGeminiAccount;
	return new AccountPoolService(new D1GeminiAccountStore(db), {
		...options,
		rotateCookie,
		verifyAccount,
	});
}

export function getGeminiAccountPoolFromEnv(
	env: WorkerEnv | null | undefined,
): AccountPoolService | null {
	const db = d1BindingFromEnv(env);
	if (!db) return null;
	const existing = DEFAULT_POOL_BY_DB.get(db);
	if (existing) return existing;
	const pool = createGeminiAccountPoolFromEnv(env);
	if (!pool) return null;
	DEFAULT_POOL_BY_DB.set(db, pool);
	return pool;
}

export function d1BindingFromEnv(
	env: WorkerEnv | null | undefined,
): D1DatabaseLike | null {
	const binding = env?.GEMINI_DB;
	if (!isD1DatabaseLike(binding)) return null;
	return binding;
}

function isD1DatabaseLike(value: unknown): value is D1DatabaseLike {
	if (!value || typeof value !== "object") return false;
	return typeof (value as Partial<D1DatabaseLike>).prepare === "function";
}
