import type { RuntimeConfig, AppEnv } from "../../config";
import type { GeminiPublicFamily } from "../../models";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import type { UnknownRecord } from "../../shared/types";
import { mapWithConcurrency } from "../concurrency";
import { fetchGoogleCookieRotation } from "../cookies";
import {
	createInputFromAccount,
	cookieUpdateFromBody,
	GeminiAccountAdminError,
	hasAccountUpdate,
	normalizeBulkAction,
	normalizeCreateAccounts,
	normalizeListFilter,
	normalizeModelRoutePriority,
	type GeminiAccountAdminFilterInput,
	updateFromBody,
} from "./admin-input";
import type {
	GeminiAccountAdminOverview,
	GeminiAccountBulkCreateEntry,
	GeminiAccountMutationError,
	GeminiAccountMutationResult,
	GeminiModelRoutingOverview,
} from "./types";
import type {
	GeminiAccountCookieRotator,
	GeminiAccountRefreshReason,
} from "./lease";
import {
	identityHashFromCookie,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./domain";
import { AccountPoolService } from "./pool";
import { capabilityFreshAfterMs } from "./pool-snapshot";
import { verifyGeminiAccount } from "./probe";
import type { GeminiAccountVerifier } from "./probe";
import type { GeminiRouteTuple } from "./routes";
import { geminiRouteKey } from "./routes";
import { sqlBindingFromEnv } from "./runtime";
import type { GeminiAccountStore } from "./types";
import type { SqlDatabaseLike } from "./types";
import { SqlGeminiAccountStore } from "./store-sql";

export { GeminiAccountAdminError } from "./admin-input";

export type GeminiAccountAdminServiceOptions = {
	store: GeminiAccountStore;
	cfg: RuntimeConfig;
	nowMs?: () => number;
	rotateCookie?: GeminiAccountCookieRotator;
	verifyAccount?: GeminiAccountVerifier;
	maxCreateAccounts?: number | null;
};

type GeminiAccountAdminFactoryOptions = Partial<
	Omit<GeminiAccountAdminServiceOptions, "store" | "cfg">
>;

type MutationOutcome =
	| { changed: true }
	| { changed: false; error?: GeminiAccountMutationError };

export class GeminiAccountAdminService {
	private readonly store: GeminiAccountStore;
	private readonly cfg: RuntimeConfig;
	private readonly nowMs: () => number;
	private readonly pool: AccountPoolService;
	private readonly maxCreateAccounts: number | null;

	constructor(options: GeminiAccountAdminServiceOptions) {
		this.store = options.store;
		this.cfg = options.cfg;
		this.nowMs = options.nowMs || Date.now;
		this.maxCreateAccounts = options.maxCreateAccounts ?? null;
		this.pool = new AccountPoolService(this.store, {
			nowMs: this.nowMs,
			snapshotTtlMs: 1,
			versionProbeTtlMs: 1,
			selectableLimit: 200,
			rotateCookie:
				options.rotateCookie ||
				((input) =>
					fetchGoogleCookieRotation(input.config, input.account.cookie_header)),
			verifyAccount: options.verifyAccount || verifyGeminiAccount,
		});
	}

	overview(
		filter: GeminiAccountAdminFilterInput,
	): Promise<GeminiAccountAdminOverview> {
		return this.store.getAdminOverview(
			normalizeListFilter(filter),
			this.nowMs(),
		);
	}

	modelRoutingOverview(): Promise<GeminiModelRoutingOverview> {
		return this.pool.modelRoutingOverview(this.capabilityFreshAfterMs());
	}

	async replaceModelRoutePriority(
		family: GeminiPublicFamily,
		body: UnknownRecord,
	): Promise<GeminiModelRoutingOverview> {
		const routes = normalizeModelRoutePriority(body, family);
		await this.assertKnownModelRoutes(family, routes);
		await this.store.replaceModelRoutePriority(family, routes, this.nowMs());
		this.pool.invalidateSnapshot();
		return this.modelRoutingOverview();
	}

	async clearModelRoutePriority(
		family: GeminiPublicFamily,
	): Promise<GeminiModelRoutingOverview> {
		await this.store.clearModelRoutePriority(family, this.nowMs());
		this.pool.invalidateSnapshot();
		return this.modelRoutingOverview();
	}

	async create(body: UnknownRecord): Promise<GeminiAccountMutationResult> {
		const accounts = normalizeCreateAccounts(body, this.maxCreateAccounts);
		const nowMs = this.nowMs();
		const uniqueEntries = new Map<string, GeminiAccountBulkCreateEntry>();
		for (const account of accounts) {
			const input = createInputFromAccount(account, nowMs);
			const cookieHash = await sha256Hex(
				normalizeGeminiCookieHeader(input.cookieHeader),
			);
			const identityHash = await identityHashFromCookie(input.cookieHeader);
			uniqueEntries.set(identityHash, {
				cookieHash,
				input: { ...input, identityHash },
			});
		}

		const entries = Array.from(uniqueEntries.values());
		const stored = await this.store.createAccountsBulk(entries);
		const changed =
			stored.createdAccountIds.size + stored.changedCredentialCount;
		const result = mutationResult(accounts.length, changed, [], 0);
		await this.scheduleImportedAccountProbes([...stored.createdAccountIds]);
		return result;
	}

	async update(
		id: string,
		body: UnknownRecord,
	): Promise<GeminiAccountMutationResult> {
		const update = updateFromBody(body, this.nowMs());
		if (!hasAccountUpdate(update))
			throw new GeminiAccountAdminError(
				400,
				"account_update_required",
				"no account update fields provided",
			);
		const result = await this.store.updateAccount(id, update);
		if (!result.item) return mutationResult(1, 0, [accountNotFoundError(id)]);
		return mutationResult(1, result.changed ? 1 : 0);
	}

	async replaceCookie(
		id: string,
		body: UnknownRecord,
	): Promise<GeminiAccountMutationResult> {
		const cookie = cookieUpdateFromBody(body);
		const result = await this.pool
			.createCandidateCookieService(this.cfg)
			.replace({
				accountId: id,
				...cookie,
				observedEmail: null,
				allowIdentityChange: true,
				nowMs: this.nowMs(),
			});
		if (!result.ok) throw candidateCookieAdminError(result.code);
		return mutationResult(1, result.changed ? 1 : 0);
	}

	async delete(id: string): Promise<GeminiAccountMutationResult> {
		const changed = await this.store.deleteAccount(id, this.nowMs());
		return changed
			? mutationResult(1, 1)
			: mutationResult(1, 0, [accountNotFoundError(id)]);
	}

	async runBulkAction(
		body: UnknownRecord,
	): Promise<GeminiAccountMutationResult> {
		const { action, ids } = normalizeBulkAction(body);
		const nowMs = this.nowMs();
		const outcomes = await mapWithConcurrency(ids, 4, async (id) => {
			if (action === "refresh") return this.refreshOneAccount(id);
			if (action === "delete") {
				return (await this.store.deleteAccount(id, nowMs))
					? ({ changed: true } as const)
					: ({ changed: false, error: accountNotFoundError(id) } as const);
			}
			const result = await this.store.updateAccount(id, {
				enabled: action === "enable",
				nowMs,
			});
			if (!result.item)
				return {
					changed: false as const,
					error: accountNotFoundError(id),
				} satisfies MutationOutcome;
			return { changed: result.changed } as MutationOutcome;
		});
		return mutationResultFromOutcomes(outcomes);
	}

	async refresh(id: string): Promise<GeminiAccountMutationResult> {
		return mutationResultFromOutcomes([await this.refreshOneAccount(id)]);
	}

	private capabilityFreshAfterMs(): number {
		return capabilityFreshAfterMs(
			this.cfg.gemini_account_capability_ttl_sec,
			this.nowMs(),
		);
	}

	private async refreshOneAccount(id: string): Promise<MutationOutcome> {
		const account = await this.store.getAccountForRefresh(id);
		if (!account) return { changed: false, error: accountNotFoundError(id) };
		try {
			const refresh = await this.pool.refreshAccountForAdmin(this.cfg, account);
			if (refresh.changed) return { changed: true };
			if (isRefreshFailure(refresh.reason)) {
				return {
					changed: false,
					error: {
						id,
						code: refresh.reason,
						message: refreshFailureMessage(refresh.reason),
					},
				};
			}
			return { changed: false };
		} catch (error) {
			log(
				this.cfg,
				`admin account refresh failed id=${id} ${errorLogSummary(error)}`,
			);
			return {
				changed: false,
				error: {
					id,
					code: "account_refresh_failed",
					message: "account refresh failed",
				},
			};
		}
	}

	private async scheduleImportedAccountProbes(
		accountIds: readonly string[],
	): Promise<void> {
		const uniqueIds = [...new Set(accountIds)];
		if (!uniqueIds.length) return;
		const probes = mapWithConcurrency(uniqueIds, 4, async (id) => {
			try {
				const account = await this.store.getAccountForRefresh(id);
				if (!account) return;
				const result = await this.pool.refreshAccountForAdmin(
					this.cfg,
					account,
					"import",
				);
				if (isRefreshFailure(result.reason))
					log(
						this.cfg,
						`post-import account probe incomplete accountId=${id} reason=${result.reason}`,
					);
			} catch (error) {
				log(
					this.cfg,
					`post-import account probe failed accountId=${id} ${errorLogSummary(error)}`,
				);
			}
		});
		await probes;
	}

	private async assertKnownModelRoutes(
		family: GeminiPublicFamily,
		routes: readonly GeminiRouteTuple[],
	): Promise<void> {
		const overview = await this.modelRoutingOverview();
		const known = overview.families.find((item) => item.family === family);
		const knownKeys = new Set((known?.routes || []).map(geminiRouteKey));
		for (const route of routes) {
			if (knownKeys.has(geminiRouteKey(route))) continue;
			throw new GeminiAccountAdminError(
				400,
				"unknown_model_route",
				"model routing policy contains an undiscovered route",
			);
		}
	}
}

export function createGeminiAccountAdminServiceFromEnv(
	env: AppEnv | null | undefined,
	cfg: RuntimeConfig,
	options: GeminiAccountAdminFactoryOptions = {},
): GeminiAccountAdminService {
	const db = sqlBindingFromEnv(env);
	if (!db)
		throw new GeminiAccountAdminError(
			503,
			"gemini_account_store_unavailable",
			"Gemini account SQL storage is not configured",
		);
	return createGeminiAccountAdminServiceFromSql(db, cfg, options);
}

function createGeminiAccountAdminServiceFromSql(
	db: SqlDatabaseLike,
	cfg: RuntimeConfig,
	options: GeminiAccountAdminFactoryOptions = {},
): GeminiAccountAdminService {
	const store = new SqlGeminiAccountStore(db);
	return new GeminiAccountAdminService({
		...options,
		store,
		cfg,
	});
}

function mutationResultFromOutcomes(
	outcomes: readonly MutationOutcome[],
): GeminiAccountMutationResult {
	const changed = outcomes.filter((outcome) => outcome.changed).length;
	const errors = outcomes.flatMap((outcome) =>
		!outcome.changed && outcome.error ? [outcome.error] : [],
	);
	return mutationResult(outcomes.length, changed, errors);
}

function mutationResult(
	processed: number,
	changed: number,
	errors: GeminiAccountMutationError[] = [],
	failed = errors.length,
): GeminiAccountMutationResult {
	const result: GeminiAccountMutationResult = {
		processed,
		changed,
		unchanged: processed - changed - failed,
		failed,
	};
	if (errors.length) result.errors = errors;
	return result;
}

function accountNotFoundError(id: string): GeminiAccountMutationError {
	return { id, code: "account_not_found", message: "account not found" };
}

function candidateCookieAdminError(code: string): GeminiAccountAdminError {
	if (code === "browser_account_not_found")
		return new GeminiAccountAdminError(404, code, "account not found");
	if (
		code === "browser_cookie_conflict" ||
		code === "browser_identity_mismatch"
	)
		return new GeminiAccountAdminError(
			409,
			code,
			"cookie belongs to another account or changed concurrently",
		);
	if (code === "browser_account_restricted")
		return new GeminiAccountAdminError(
			422,
			code,
			"Gemini account is restricted",
		);
	if (code === "browser_cookie_verification_failed")
		return new GeminiAccountAdminError(
			502,
			code,
			"Gemini cookie verification failed",
		);
	return new GeminiAccountAdminError(400, code, "invalid Gemini cookie values");
}

function isRefreshFailure(reason: GeminiAccountRefreshReason): boolean {
	return (
		reason === "missing_secure_1psid" ||
		reason === "account_missing" ||
		reason === "rotation_rejected" ||
		reason === "rotation_failed" ||
		reason === "rotation_duplicate" ||
		reason === "missing_page_at_token" ||
		reason === "status_probe_failed" ||
		reason === "status_restricted"
	);
}

function refreshFailureMessage(reason: GeminiAccountRefreshReason): string {
	if (reason === "missing_secure_1psid") return "account cookie is incomplete";
	if (reason === "account_missing") return "account not found";
	if (reason === "rotation_rejected") return "account refresh was rejected";
	if (reason === "rotation_duplicate")
		return "refreshed cookie belongs to another account";
	if (reason === "missing_page_at_token")
		return "Gemini session bootstrap did not return an auth token";
	if (reason === "status_probe_failed")
		return "Gemini account status probe failed";
	if (reason === "status_restricted")
		return "Gemini account status restricts access";
	return "account refresh failed";
}
