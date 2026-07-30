import {
	captureConfigSnapshot,
	configSnapshotMatches,
	parseStaticRuntimeConfig,
	type ConfigCacheSnapshot,
} from "./spec";
import type {
	GeminiAccountSessionContext,
	RuntimeConfig,
	RuntimeExecutionContext,
	StaticRuntimeConfig,
	AppEnv,
} from "./types";

export const VERSION = "2.0.0-docker";

export type {
	GeminiAccountLeaseContext,
	GeminiAccountSessionContext,
	RuntimeConfig,
	RuntimeExecutionContext,
	StaticRuntimeConfig,
	AppEnv,
} from "./types";
export { RuntimeConfigError } from "./parse";

export function createRuntimeConfig(
	config: StaticRuntimeConfig,
	execution: RuntimeExecutionContext = {},
	session: Partial<GeminiAccountSessionContext> = {},
): RuntimeConfig {
	return {
		...config,
		...execution,
		...session,
		cookie: session.cookie ?? "",
		sapisid: session.sapisid ?? "",
	};
}

const DEFAULT_ENV: AppEnv = {};
type ConfigCacheEntry = {
	snapshot: ConfigCacheSnapshot;
	value: StaticRuntimeConfig;
};
const CONFIG_CACHE = new WeakMap<AppEnv, ConfigCacheEntry>();

export function getConfig(env: AppEnv = DEFAULT_ENV): StaticRuntimeConfig {
	const activeEnv = env || DEFAULT_ENV;
	const cached = CONFIG_CACHE.get(activeEnv);
	if (cached && configSnapshotMatches(cached.snapshot, activeEnv))
		return cached.value;
	const value = parseStaticRuntimeConfig(activeEnv);
	CONFIG_CACHE.set(activeEnv, {
		snapshot: captureConfigSnapshot(activeEnv),
		value,
	});
	return value;
}

export function assertRuntimeConfig(env: AppEnv = DEFAULT_ENV): void {
	void getConfig(env);
}
