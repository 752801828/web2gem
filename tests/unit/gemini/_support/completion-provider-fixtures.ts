import type { RuntimeConfig } from "../../../../src/config";
import type { GeminiAccountLease } from "../../../../src/gemini/accounts/lease";
import type { GeminiRouteTuple } from "../../../../src/gemini/accounts/routes";
import { basicRouteForFamily } from "../../../../src/gemini/accounts/routes";
import type { AccountPoolService } from "../../../../src/gemini/accounts/pool";
import type { GeminiAccountAcquireOptions } from "../../../../src/gemini/accounts/types";
import type { GeminiCompletionProviderOptions } from "../../../../src/gemini/completion-provider";
import type { ResolvedModelOk } from "../../../../src/models";
import { baseGeminiClientConfig } from "./client-fixtures.js";

type ClientOverrides = NonNullable<GeminiCompletionProviderOptions["client"]>;
type UploadOverrides = NonNullable<GeminiCompletionProviderOptions["uploads"]>;

export type ScriptedAcquireRecord = {
	base: RuntimeConfig;
	excludeAccountIds: string[];
	routeRequirement: GeminiAccountAcquireOptions["routeRequirement"];
	capabilityMode: GeminiAccountAcquireOptions["capabilityMode"];
	capabilityFreshAfterMs: GeminiAccountAcquireOptions["capabilityFreshAfterMs"];
};

export type ScriptedRuntimeRecords = {
	route: [ResolvedModelOk, number][];
	acquire: ScriptedAcquireRecord[];
};

export type ScriptedPoolMethods = {
	acquireLease: AccountPoolService["acquireLease"];
	resolveModel: AccountPoolService["resolveModel"];
	routeCandidatesForModel: AccountPoolService["routeCandidatesForModel"];
	modelCatalog: AccountPoolService["modelCatalog"];
	modelRoutingOverview: AccountPoolService["modelRoutingOverview"];
};

export type ScriptedRuntimeWithRoutes = ScriptedPoolMethods & {
	records: ScriptedRuntimeRecords;
};

export function flashModel(extended = false): ResolvedModelOk {
	return {
		name: extended ? "gemini-3.5-flash-extended" : "gemini-3.5-flash",
		family: "flash",
		extended,
		dynamicProviderId: null,
	};
}

export function proModel(extended = false): ResolvedModelOk {
	return {
		name: extended ? "gemini-3.1-pro-extended" : "gemini-3.1-pro",
		family: "pro",
		extended,
		dynamicProviderId: null,
	};
}

export function accountConfig(
	accountId: string,
	base: RuntimeConfig = baseGeminiClientConfig(),
): RuntimeConfig {
	return {
		...base,
		cookie: `__Secure-1PSID=psid-${accountId}`,
		gemini_account: {
			accountId,
			cookieHash: `hash-${accountId}`,
		},
	};
}

export function requireItem<T>(items: readonly T[], index = 0): T {
	const item = items[index];
	if (item === undefined) throw new Error(`expected item at index ${index}`);
	return item;
}

export function requireAccount(config: RuntimeConfig) {
	const account = config.gemini_account;
	if (!account) throw new Error("expected Gemini account context");
	return account;
}

export function errorRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object") {
		throw new Error("expected an error object");
	}
	return value as Record<string, unknown>;
}

export async function captureError(
	run: () => unknown | PromiseLike<unknown>,
): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected rejection");
}

export function failFastClient(
	overrides: Partial<ClientOverrides> = {},
): ClientOverrides {
	return {
		async generate() {
			throw new Error("unexpected client.generate call");
		},
		async generateRich() {
			throw new Error("unexpected client.generateRich call");
		},
		generateStream() {
			throw new Error("unexpected client.generateStream call");
		},
		...overrides,
	};
}

export function failFastUploads(
	overrides: Partial<UploadOverrides> = {},
): UploadOverrides {
	return {
		async resolveAttachments() {
			throw new Error("unexpected uploads.resolveAttachments call");
		},
		async uploadTextFile() {
			throw new Error("unexpected uploads.uploadTextFile call");
		},
		...overrides,
	};
}

export function rateLimitError(accountId: string) {
	return Object.assign(new Error(`rate limited ${accountId}`), { status: 429 });
}

export function requestScopedError(message = "model invalid for this request") {
	return Object.assign(new Error(message), { code: "invalid_model" });
}

export function proRoutes(): [GeminiRouteTuple, GeminiRouteTuple] {
	return [
		basicRouteForFamily("pro"),
		{
			providerModelId: "e6fa609c3fa255c0",
			capacity: 4,
			capacityField: 12,
			modelNumber: 3,
		},
	];
}

/**
 * Lightweight scripted runtime for failover/recovery contracts.
 * Uses a plain object (not AccountPoolService) to keep fixtures free of
 * heavy runtime/store import cycles.
 */
export function scriptedRuntimeWithRoutes(
	leases: GeminiAccountLease[],
	routes: GeminiRouteTuple[],
): ScriptedRuntimeWithRoutes {
	const pending = [...leases];
	const records: ScriptedRuntimeRecords = { route: [], acquire: [] };
	return {
		records,
		async resolveModel(): Promise<never> {
			throw new Error("unexpected accountPool.resolveModel call");
		},
		async modelCatalog(): Promise<never> {
			throw new Error("unexpected accountPool.modelCatalog call");
		},
		async modelRoutingOverview(): Promise<never> {
			throw new Error("unexpected accountPool.modelRoutingOverview call");
		},
		async routeCandidatesForModel(
			model: ResolvedModelOk,
			freshAfterMs: number,
		) {
			records.route.push([model, freshAfterMs]);
			return routes;
		},
		async acquireLease(
			base: RuntimeConfig,
			options: GeminiAccountAcquireOptions = {},
		) {
			records.acquire.push({
				base,
				excludeAccountIds: [...(options.excludeAccountIds || [])],
				routeRequirement: options.routeRequirement,
				capabilityMode: options.capabilityMode,
				capabilityFreshAfterMs: options.capabilityFreshAfterMs,
			});
			if (!pending.length)
				throw new Error("unexpected extra account acquisition");
			return pending.shift() ?? null;
		},
	} as ScriptedRuntimeWithRoutes;
}

export function asAccountPool(
	pool: ScriptedRuntimeWithRoutes,
): ScriptedRuntimeWithRoutes & AccountPoolService {
	return pool as unknown as ScriptedRuntimeWithRoutes & AccountPoolService;
}
