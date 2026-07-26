import { GEMINI_PUBLIC_FAMILIES, publicNamesForFamily } from "../../models";
import type { GeminiPublicFamily } from "../../models";
import type {
	GeminiAccountCapabilityRow,
	GeminiAccountModelCapability,
	GeminiCatalogRoute,
	GeminiRouteTuple,
} from "./routes";
import {
	availableAccountsByRoute,
	capabilitiesByAccount as buildCapabilitiesByAccount,
	capabilityFromRow,
	catalogRoute,
	geminiRouteKey,
	knownTierLabel,
	mergeSavedAndDiscoveredRoutes,
	routePrioritiesByFamily,
	uniqueRouteTuples,
} from "./routes";
import type {
	GeminiAccountOutcome,
	GeminiAccountStore,
	GeminiAccountSnapshotRow,
	GeminiModelRoutingOverview,
} from "./types";

export type PoolAccountState = {
	cookieHeader: string;
	cookieHash: string;
	lastRotateAtMs: number;
};

export function positiveIntOption(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function capabilityFreshAfterMs(
	ttlSeconds: unknown,
	nowMs: number,
): number {
	return nowMs - Math.max(Number(ttlSeconds) || 3600, 60) * 1000;
}

export function applyOutcomeToSnapshot(
	rows: readonly GeminiAccountSnapshotRow[],
	accountId: string,
	outcome: GeminiAccountOutcome,
): GeminiAccountSnapshotRow[] {
	return rows.map((row) => {
		if (row.id !== accountId) return row;
		if (outcome.kind === "success") {
			return {
				...row,
				issue: null,
				cooldown_until_ms: null,
				last_used_at_ms: outcome.nowMs,
			};
		}
		return {
			...row,
			issue: outcome.issue ?? row.issue,
			cooldown_until_ms:
				outcome.issue === undefined
					? row.cooldown_until_ms
					: (outcome.cooldownUntilMs ?? null),
			last_used_at_ms: outcome.nowMs,
		};
	});
}

export function applyRefreshToSnapshot(
	rows: readonly GeminiAccountSnapshotRow[],
	accountId: string,
	cookieHeader: string,
	cookieHash: string,
): GeminiAccountSnapshotRow[] {
	return rows.map((row) =>
		row.id === accountId
			? {
					...row,
					cookie_header: cookieHeader,
					cookie_hash: cookieHash,
				}
			: row,
	);
}

export async function loadSelectedCapabilityRows(
	store: GeminiAccountStore,
	rows: readonly GeminiAccountSnapshotRow[],
	globalRowsPromise: Promise<GeminiAccountCapabilityRow[]> | null,
): Promise<GeminiAccountCapabilityRow[]> {
	if (!rows.length) return [];
	const accountIds = rows.map((row) => row.id);
	if (store.listAccountCapabilities)
		return store.listAccountCapabilities(accountIds);
	if (!globalRowsPromise) return [];
	const selectedIds = new Set(accountIds);
	return (await globalRowsPromise).filter((row) =>
		selectedIds.has(row.account_id),
	);
}

export function freshSelectableCatalogRoutes(
	rows: readonly GeminiAccountSnapshotRow[],
	capabilitiesByAccount: ReadonlyMap<
		string,
		ReadonlyMap<string, GeminiAccountModelCapability>
	>,
	freshAfterMs: number,
): GeminiCatalogRoute[] {
	const routes: GeminiCatalogRoute[] = [];
	for (const row of rows) {
		const capabilities = [
			...(capabilitiesByAccount.get(row.id)?.values() || []),
		].sort((a, b) => a.discoveryOrder - b.discoveryOrder);
		for (const capability of capabilities) {
			if (!capability.available || capability.checkedAtMs < freshAfterMs)
				continue;
			routes.push(catalogRoute(row.id, capability));
		}
	}
	return routes;
}

export function persistedCatalogRoutes(
	rows: readonly GeminiAccountCapabilityRow[],
): GeminiCatalogRoute[] {
	const routes: GeminiCatalogRoute[] = [];
	for (const row of rows) {
		if (row.available === 0) continue;
		const capability = capabilityFromRow(row);
		if (!capability) continue;
		routes.push(catalogRoute(row.account_id, capability));
	}
	return routes;
}

export function buildModelRoutingOverview(
	version: string,
	routePriorities: ReadonlyMap<GeminiPublicFamily, readonly GeminiRouteTuple[]>,
	persisted: readonly GeminiCatalogRoute[],
	fresh: readonly GeminiCatalogRoute[],
): GeminiModelRoutingOverview {
	const availableAccounts = availableAccountsByRoute(fresh);
	return {
		version,
		families: GEMINI_PUBLIC_FAMILIES.map((family) => {
			const saved = routePriorities.get(family) || [];
			const savedKeys = new Set(saved.map(geminiRouteKey));
			const discovered = uniqueRouteTuples(
				persisted.filter((route) => route.family === family),
			);
			return {
				family,
				publicNames: publicNamesForFamily(family),
				configured: saved.length > 0,
				routes: mergeSavedAndDiscoveredRoutes(saved, discovered).map(
					(route) => {
						const accountCount =
							availableAccounts.get(geminiRouteKey(route))?.size || 0;
						return {
							...route,
							label: knownTierLabel(route),
							available: accountCount > 0,
							configured: savedKeys.has(geminiRouteKey(route)),
							accountCount,
						};
					},
				),
			};
		}),
	};
}

export type PoolSnapshotState = {
	snapshotRows: GeminiAccountSnapshotRow[];
	capabilitiesByAccount: Map<string, Map<string, GeminiAccountModelCapability>>;
	persistedCapabilities: GeminiAccountCapabilityRow[];
	routePriorities: Map<GeminiPublicFamily, GeminiRouteTuple[]>;
	snapshotVersion: string;
	snapshotExpiresAtMs: number;
	nextVersionProbeAtMs: number;
	pendingSnapshotLoad: Promise<GeminiAccountSnapshotRow[]> | null;
};

export type PoolSnapshotOptions = {
	store: GeminiAccountStore;
	snapshotTtlMs: number;
	versionProbeTtlMs: number;
	selectableLimit: number;
};

export function createPoolSnapshotState(): PoolSnapshotState {
	return {
		snapshotRows: [],
		capabilitiesByAccount: new Map(),
		persistedCapabilities: [],
		routePriorities: new Map(),
		snapshotVersion: "",
		snapshotExpiresAtMs: 0,
		nextVersionProbeAtMs: 0,
		pendingSnapshotLoad: null,
	};
}

export function invalidatePoolSnapshot(state: PoolSnapshotState): void {
	state.snapshotExpiresAtMs = 0;
	state.nextVersionProbeAtMs = 0;
}

export async function loadSelectableSnapshot(
	state: PoolSnapshotState,
	options: PoolSnapshotOptions,
	nowMs: number,
): Promise<GeminiAccountSnapshotRow[]> {
	const hasFreshSnapshot = nowMs < state.snapshotExpiresAtMs;
	if (hasFreshSnapshot && nowMs < state.nextVersionProbeAtMs)
		return state.snapshotRows;
	if (state.pendingSnapshotLoad) return state.pendingSnapshotLoad;

	const load = refreshSelectableSnapshot(
		state,
		options,
		nowMs,
		hasFreshSnapshot,
	);
	state.pendingSnapshotLoad = load;
	try {
		return await load;
	} finally {
		if (state.pendingSnapshotLoad === load) state.pendingSnapshotLoad = null;
	}
}

async function refreshSelectableSnapshot(
	state: PoolSnapshotState,
	options: PoolSnapshotOptions,
	nowMs: number,
	hasFreshSnapshot: boolean,
): Promise<GeminiAccountSnapshotRow[]> {
	const version = await options.store.getPoolVersion();
	state.nextVersionProbeAtMs = nowMs + options.versionProbeTtlMs;
	if (hasFreshSnapshot && version === state.snapshotVersion)
		return state.snapshotRows;

	const rows = await options.store.listSelectableAccounts(
		nowMs,
		options.selectableLimit,
	);
	state.snapshotRows = rows;
	const globalCapabilityRowsPromise = options.store.listAllAccountCapabilities
		? options.store.listAllAccountCapabilities(
				Math.min(options.selectableLimit * 128, 12800),
			)
		: null;
	const selectedCapabilityRowsPromise = loadSelectedCapabilityRows(
		options.store,
		rows,
		globalCapabilityRowsPromise,
	);
	const [selectedCapabilityRows, persistedCapabilityRows, priorities] =
		await Promise.all([
			selectedCapabilityRowsPromise,
			globalCapabilityRowsPromise || selectedCapabilityRowsPromise,
			options.store.listModelRoutePriorities?.() || Promise.resolve([]),
		]);
	state.persistedCapabilities = persistedCapabilityRows;
	state.capabilitiesByAccount = buildCapabilitiesByAccount(
		selectedCapabilityRows,
	);
	state.routePriorities = routePrioritiesByFamily(priorities);
	state.snapshotVersion = version;
	state.snapshotExpiresAtMs = nowMs + options.snapshotTtlMs;
	return rows;
}
