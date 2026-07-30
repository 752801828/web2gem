import type { AppEnv } from "../../config";
import { fetchGoogleCookieRotation } from "../cookies";
import { AccountPoolService } from "./pool";
import { verifyGeminiAccount } from "./probe";
import type { GeminiAccountPoolOptions } from "./pool";
import type { SqlDatabaseLike } from "./types";
import { SqlGeminiAccountStore } from "./store-sql";

const DEFAULT_POOL_BY_DB = new WeakMap<SqlDatabaseLike, AccountPoolService>();

function createGeminiAccountPoolFromEnv(
	env: AppEnv | null | undefined,
	options: GeminiAccountPoolOptions = {},
): AccountPoolService | null {
	const db = sqlBindingFromEnv(env);
	if (!db) return null;
	const rotateCookie =
		options.rotateCookie ||
		((input) =>
			fetchGoogleCookieRotation(input.config, input.account.cookie_header));
	const verifyAccount = options.verifyAccount || verifyGeminiAccount;
	return new AccountPoolService(new SqlGeminiAccountStore(db), {
		...options,
		rotateCookie,
		verifyAccount,
	});
}

export function getGeminiAccountPoolFromEnv(
	env: AppEnv | null | undefined,
): AccountPoolService | null {
	const db = sqlBindingFromEnv(env);
	if (!db) return null;
	const existing = DEFAULT_POOL_BY_DB.get(db);
	if (existing) return existing;
	const pool = createGeminiAccountPoolFromEnv(env);
	if (!pool) return null;
	DEFAULT_POOL_BY_DB.set(db, pool);
	return pool;
}

export function sqlBindingFromEnv(
	env: AppEnv | null | undefined,
): SqlDatabaseLike | null {
	const binding = env?.ACCOUNT_DB;
	if (!isSqlDatabaseLike(binding)) return null;
	return binding;
}

function isSqlDatabaseLike(value: unknown): value is SqlDatabaseLike {
	if (!value || typeof value !== "object") return false;
	return typeof (value as Partial<SqlDatabaseLike>).prepare === "function";
}
