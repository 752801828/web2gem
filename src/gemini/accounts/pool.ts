import type { RuntimeConfig } from "../../config";
import {
	buildGeminiModelCatalog,
	type GeminiModelCatalog,
	type ResolvedModel,
	resolveModelFromCatalog,
} from "../../models";
import type { GeminiModelRoutingOverview } from "./types";
import { classifyGeminiAccountOutcome } from "./domain";
import { PoolLease } from "./lease";
import type {
	GeminiAccountCookieRotator,
	GeminiAccountLease,
	GeminiAccountRefreshResult,
} from "./lease";
import { choosePoolAccount } from "./pool-selection";
import {
	buildModelRoutingOverview,
	freshSelectableCatalogRoutes,
	persistedCatalogRoutes,
} from "./pool-snapshot";
import {
	type PoolRefreshHost,
	persistObservedCookies,
	refreshAccount,
} from "./pool-refresh";
import {
	createPoolSnapshotState,
	invalidatePoolSnapshot,
	loadSelectableSnapshot,
	type PoolSnapshotState,
} from "./pool-snapshot";
import {
	type PoolAccountState,
	applyOutcomeToSnapshot,
	positiveIntOption,
} from "./pool-snapshot";
import { verifyGeminiAccount } from "./probe";
import type { GeminiAccountVerifier } from "./probe";
import type { GeminiRouteTuple } from "./routes";
import { reconcileRoutePriority, uniqueRouteTuples } from "./routes";
import type {
	GeminiAccountAcquireOptions,
	GeminiAccountOutcome,
	GeminiAccountStore,
	GeminiAccountSnapshotRow,
} from "./types";
import type { GeminiAccountSecretRow } from "./types";

const DEFAULT_SNAPSHOT_TTL_MS = 30 * 1000;
const DEFAULT_VERSION_PROBE_TTL_MS = 1 * 1000;
const DEFAULT_SELECTABLE_LIMIT = 100;
const DEFAULT_REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;

type AccountPoolServiceOptions = Omit<
	GeminiAccountPoolOptions,
	"rotateCookie" | "verifyAccount"
> & {
	rotateCookie: GeminiAccountCookieRotator;
	verifyAccount?: GeminiAccountVerifier;
};

export type GeminiAccountPoolOptions = {
	nowMs?: () => number;
	snapshotTtlMs?: number;
	versionProbeTtlMs?: number;
	selectableLimit?: number;
	refreshLockTtlMs?: number;
	rotateCookie?: import("./lease").GeminiAccountCookieRotator;
	verifyAccount?: import("./probe").GeminiAccountVerifier;
};

export class AccountPoolService {
	private readonly nowMs: () => number;
	private readonly snapshotTtlMs: number;
	private readonly versionProbeTtlMs: number;
	private readonly selectableLimit: number;
	private readonly refreshLockTtlMs: number;
	private readonly rotateCookie: GeminiAccountCookieRotator;
	private readonly verifyAccount: GeminiAccountVerifier;
	private readonly inFlight = new Map<string, number>();
	private readonly accountStates = new Map<string, PoolAccountState>();
	private readonly pendingRefresh = new Map<
		string,
		Promise<GeminiAccountRefreshResult>
	>();
	private readonly snapshot: PoolSnapshotState = createPoolSnapshotState();
	private roundRobinCursor = 0;
	private readonly refreshHost: PoolRefreshHost;

	constructor(
		private readonly store: GeminiAccountStore,
		options: AccountPoolServiceOptions,
	) {
		this.nowMs = options.nowMs || Date.now;
		this.snapshotTtlMs = positiveIntOption(
			options.snapshotTtlMs,
			DEFAULT_SNAPSHOT_TTL_MS,
		);
		this.versionProbeTtlMs = positiveIntOption(
			options.versionProbeTtlMs,
			DEFAULT_VERSION_PROBE_TTL_MS,
		);
		this.selectableLimit = positiveIntOption(
			options.selectableLimit,
			DEFAULT_SELECTABLE_LIMIT,
		);
		this.refreshLockTtlMs = positiveIntOption(
			options.refreshLockTtlMs,
			DEFAULT_REFRESH_LOCK_TTL_MS,
		);
		this.rotateCookie = options.rotateCookie;
		this.verifyAccount = options.verifyAccount || verifyGeminiAccount;
		this.refreshHost = {
			store: this.store,
			rotateCookie: this.rotateCookie,
			verifyAccount: this.verifyAccount,
			refreshLockTtlMs: this.refreshLockTtlMs,
			nowMs: () => this.nowMs(),
			accountStates: this.accountStates,
			pendingRefresh: this.pendingRefresh,
			getSnapshotRows: () => this.snapshot.snapshotRows,
			setSnapshotRows: (rows) => {
				this.snapshot.snapshotRows = rows;
			},
			markSuccess: (accountId, nowMs) => this.markSuccess(accountId, nowMs),
			markFailure: (accountId, error, nowMs) =>
				this.markFailure(accountId, error, nowMs),
		};
	}

	async acquireLease(
		baseConfig: RuntimeConfig,
		options: GeminiAccountAcquireOptions = {},
	): Promise<GeminiAccountLease | null> {
		const nowMs = this.nowMs();
		const rows = await this.selectableSnapshot(nowMs);
		const excluded = new Set(options.excludeAccountIds || []);
		const result = choosePoolAccount({
			rows,
			nowMs,
			excludedAccountIds: excluded,
			options,
			capabilitiesByAccount: this.snapshot.capabilitiesByAccount,
			inFlight: this.inFlight,
			roundRobinCursor: this.roundRobinCursor,
		});
		this.roundRobinCursor = result.nextRoundRobinCursor;
		const selection = result.selection;
		if (!selection) return null;
		this.incrementInFlight(selection.row.id);
		return new PoolLease(
			this,
			baseConfig,
			selection.row,
			selection.capability,
			selection.route,
		);
	}

	async modelCatalog(
		capabilityFreshAfterMs: number,
	): Promise<GeminiModelCatalog> {
		await this.selectableSnapshot(this.nowMs());
		const freshRoutes = freshSelectableCatalogRoutes(
			this.snapshot.snapshotRows,
			this.snapshot.capabilitiesByAccount,
			capabilityFreshAfterMs,
		);
		const routes = freshRoutes.length
			? freshRoutes
			: persistedCatalogRoutes(this.snapshot.persistedCapabilities);
		return buildGeminiModelCatalog(routes, this.nowMs());
	}

	async resolveModel(
		modelName: unknown,
		defaultName: unknown,
		capabilityFreshAfterMs: number,
	): Promise<ResolvedModel> {
		return resolveModelFromCatalog(
			modelName,
			defaultName,
			await this.modelCatalog(capabilityFreshAfterMs),
		);
	}

	async modelRoutingOverview(
		capabilityFreshAfterMs: number,
	): Promise<GeminiModelRoutingOverview> {
		await this.selectableSnapshot(this.nowMs());
		return buildModelRoutingOverview(
			this.snapshot.snapshotVersion,
			this.snapshot.routePriorities,
			persistedCatalogRoutes(this.snapshot.persistedCapabilities),
			freshSelectableCatalogRoutes(
				this.snapshot.snapshotRows,
				this.snapshot.capabilitiesByAccount,
				capabilityFreshAfterMs,
			),
		);
	}

	invalidateSnapshot(): void {
		invalidatePoolSnapshot(this.snapshot);
	}

	async routeCandidatesForModel(
		model: Extract<ResolvedModel, { name: string }>,
		capabilityFreshAfterMs: number,
	): Promise<GeminiRouteTuple[]> {
		await this.selectableSnapshot(this.nowMs());
		const fresh = freshSelectableCatalogRoutes(
			this.snapshot.snapshotRows,
			this.snapshot.capabilitiesByAccount,
			capabilityFreshAfterMs,
		);
		const persisted = persistedCatalogRoutes(
			this.snapshot.persistedCapabilities,
		);
		const relevant = (fresh.length ? fresh : persisted).filter((route) =>
			model.family
				? route.family === model.family
				: route.providerModelId === model.dynamicProviderId,
		);
		const discovered = uniqueRouteTuples(relevant);
		if (!model.family) return discovered;
		const reconciled = reconcileRoutePriority(
			this.snapshot.routePriorities.get(model.family) || [],
			discovered,
		);
		return reconciled;
	}

	async refreshAccountForAdmin(
		baseConfig: RuntimeConfig,
		account: GeminiAccountSecretRow,
		_reason = "admin",
	): Promise<GeminiAccountRefreshResult> {
		const lease = new PoolLease(this, baseConfig, account);
		try {
			return await refreshAccount(this.refreshHost, lease, "status", true);
		} finally {
			lease.release();
		}
	}

	async selectableSnapshot(
		nowMs: number = this.nowMs(),
	): Promise<GeminiAccountSnapshotRow[]> {
		return loadSelectableSnapshot(
			this.snapshot,
			{
				store: this.store,
				snapshotTtlMs: this.snapshotTtlMs,
				versionProbeTtlMs: this.versionProbeTtlMs,
				selectableLimit: this.selectableLimit,
			},
			nowMs,
		);
	}

	localInFlight(accountId: string): number {
		return this.inFlight.get(accountId) || 0;
	}

	release(accountId: string): void {
		const current = this.localInFlight(accountId);
		if (current <= 1) this.inFlight.delete(accountId);
		else this.inFlight.set(accountId, current - 1);
	}

	async refreshForRetry(
		lease: PoolLease,
		recordFailure = true,
	): Promise<GeminiAccountRefreshResult> {
		return refreshAccount(this.refreshHost, lease, "session", recordFailure);
	}

	async markSuccess(
		accountId: string,
		nowMs: number = this.nowMs(),
	): Promise<void> {
		const outcome: GeminiAccountOutcome = { kind: "success", nowMs };
		this.snapshot.snapshotRows = applyOutcomeToSnapshot(
			this.snapshot.snapshotRows,
			accountId,
			outcome,
		);
		await this.store.writeAccountOutcome(accountId, outcome);
	}

	async markFailure(
		accountId: string,
		error: unknown,
		nowMs: number = this.nowMs(),
	): Promise<void> {
		const outcome = classifyGeminiAccountOutcome(error, nowMs);
		this.snapshot.snapshotRows = applyOutcomeToSnapshot(
			this.snapshot.snapshotRows,
			accountId,
			outcome,
		);
		await this.store.writeAccountOutcome(accountId, outcome);
	}

	async persistObservedCookies(
		lease: PoolLease,
		setCookieValues: readonly string[],
	): Promise<void> {
		return persistObservedCookies(this.refreshHost, lease, setCookieValues);
	}

	private incrementInFlight(accountId: string): void {
		this.inFlight.set(accountId, this.localInFlight(accountId) + 1);
	}
}
