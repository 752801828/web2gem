import { describe, test } from "vitest";
import type { RuntimeConfig } from "../../../../src/config/types";
import type { GeminiModelRoutingOverview } from "../../../../src/gemini/accounts/types";
import type { GeminiAccountLease } from "../../../../src/gemini/accounts/lease";
import type { GeminiRouteTuple } from "../../../../src/gemini/accounts/routes";
import {
	d1BindingFromEnv,
	getGeminiAccountPoolFromEnv,
} from "../../../../src/gemini/accounts/runtime";
import type { GeminiAccountAcquireOptions } from "../../../../src/gemini/accounts/types";
import type { ResolvedModelOk } from "../../../../src/models";
import { assert } from "../../assertions.js";
import {
	account,
	capabilityRow,
	createPool,
	createAccountStore,
	runtimeCall,
	runtimeConfig,
} from "./_support/runtime-fixtures.js";

describe("gemini account pool bootstrap", () => {
	test("exposes an ordered catalog and dynamic resolution through AccountPoolService", async () => {
		const nowMs = 100000;
		const rows = [
			account("first", { status_checked_at_ms: nowMs }),
			account("second", { status_checked_at_ms: nowMs }),
		];
		const capabilities = [
			capabilityRow("first", "e6fa609c3fa255c0", 4, 12, 3, 0, nowMs, {
				display_name: "First Pro",
			}),
			capabilityRow("first", "future-model", 3, 13, 7, 1, nowMs),
			capabilityRow("first", "invalid model id", 3, 13, 7, 2, nowMs),
			capabilityRow("first", "cf41b0e0dd7d53e5", 1, 12, 6, 3, nowMs, {
				available: 0,
			}),
			capabilityRow("second", "9d8ca3786ebdfbea", 1, 12, 3, 0, nowMs, {
				display_name: "Second Pro",
			}),
		];
		const store = createAccountStore([
			runtimeCall("getPoolVersion", [], "1"),
			runtimeCall("listSelectableAccounts", [nowMs, 100], rows),
			runtimeCall(
				"listAccountCapabilities",
				[["first", "second"]],
				capabilities,
			),
		]);
		const pool = createPool(store, nowMs);

		assert.deepEqual(
			(await pool.modelCatalog(nowMs - 1000)).entries.map((entry) => entry.id),
			[
				"gemini-3.5-flash",
				"gemini-3.5-flash-extended",
				"gemini-3.1-pro",
				"gemini-3.1-pro-extended",
				"future-model",
				"future-model-extended",
			],
		);
		assert.equal(
			(
				await pool.resolveModel(
					"future-model-extended",
					"gemini-3.5-flash",
					nowMs - 1000,
				)
			).dynamicProviderId,
			"future-model",
		);
		store.assertExhausted();
	});

	test("delegates lease and routing operations through AccountPoolService", async () => {
		const cfg = runtimeConfig();
		const options: GeminiAccountAcquireOptions = {
			excludeAccountIds: new Set(["attempted"]),
			capabilityMode: "strict",
		};
		const model: ResolvedModelOk = {
			name: "gemini-3.1-pro",
			family: "pro",
			extended: false,
			dynamicProviderId: null,
		};
		const route: GeminiRouteTuple = {
			providerModelId: "9d8ca3786ebdfbea",
			capacity: 1,
			capacityField: 12,
			modelNumber: 3,
		};
		const lease: GeminiAccountLease = {
			accountId: "selected",
			selectedRoute: null,
			modelCapability: null,
			config: cfg,
			refreshForRetry: async () => ({
				changed: false,
				reason: "recent_rotation",
			}),
			markSuccess: async () => undefined,
			markFailure: async () => undefined,
			flushObservedCookies: async () => undefined,
			maintainSessionIfStale: async () => undefined,
			release: () => undefined,
		};
		const overview: GeminiModelRoutingOverview = { version: "7", families: [] };
		const calls: unknown[][] = [];
		const pool = createPool(createAccountStore([]), 100000);
		pool.acquireLease = async (
			baseConfig: RuntimeConfig,
			acquireOptions: GeminiAccountAcquireOptions = {},
		) => {
			calls.push(["acquireLease", baseConfig, acquireOptions]);
			return lease;
		};
		pool.modelRoutingOverview = async (freshAfterMs: number) => {
			calls.push(["modelRoutingOverview", freshAfterMs]);
			return overview;
		};
		pool.routeCandidatesForModel = async (
			resolved: ResolvedModelOk,
			freshAfterMs: number,
		) => {
			calls.push(["routeCandidatesForModel", resolved, freshAfterMs]);
			return [route];
		};

		assert.equal(await pool.acquireLease(cfg, options), lease);
		assert.equal(await pool.modelRoutingOverview(99000), overview);
		assert.deepEqual(await pool.routeCandidatesForModel(model, 99000), [route]);
		assert.deepEqual(calls, [
			["acquireLease", cfg, options],
			["modelRoutingOverview", 99000],
			["routeCandidatesForModel", model, 99000],
		]);
	});

	test("reuses one pool per D1 binding while isolating distinct bindings", () => {
		const firstDb = {
			prepare() {
				throw new Error("Unexpected D1 access");
			},
		};
		const secondDb = {
			prepare() {
				throw new Error("Unexpected D1 access");
			},
		};
		const first = getGeminiAccountPoolFromEnv({ GEMINI_DB: firstDb });
		assert.equal(getGeminiAccountPoolFromEnv({ GEMINI_DB: firstDb }), first);
		assert.equal(
			getGeminiAccountPoolFromEnv({ GEMINI_DB: secondDb }) === first,
			false,
		);
		assert.equal(d1BindingFromEnv({ GEMINI_DB: firstDb }), firstDb);
		for (const env of [undefined, null, {}, { GEMINI_DB: {} }]) {
			assert.equal(d1BindingFromEnv(env), null);
			assert.equal(getGeminiAccountPoolFromEnv(env), null);
		}
	});
});
