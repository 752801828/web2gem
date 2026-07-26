import {
	type RuntimeConfig,
	RuntimeConfigError,
	type WorkerEnv,
} from "./config";
import {
	d1BindingFromEnv,
	getGeminiAccountPoolFromEnv,
} from "./gemini/accounts/runtime";
import { capabilityFreshAfterMs } from "./gemini/accounts/pool-snapshot";
import { jsonResponse } from "./http/core/json";
import { googleErrorResponseBody } from "./http/google/format";
import { openAIErrorResponse } from "./http/openai/errors";
import type { RouteJsonPostResult } from "./http/route-body";
import { buildGeminiModelCatalog, type GeminiModelCatalog } from "./models";
import {
	GEMINI_AUTHENTICATED_SESSION_REQUIRED_CODE,
	GEMINI_AUTHENTICATED_SESSION_REQUIRED_STATUS,
	errorLogSummary,
	geminiAuthenticatedSessionRequiredMessage,
	type GeminiAuthenticatedSessionReason,
} from "./shared/errors";
import { log } from "./shared/logging";

export async function applicationModelCatalog(context: {
	env: WorkerEnv;
	cfg: RuntimeConfig;
}): Promise<GeminiModelCatalog> {
	const fallback = buildGeminiModelCatalog([], Date.now());
	const accountPool = getGeminiAccountPoolFromEnv(context.env);
	if (!accountPool) return fallback;
	try {
		return await accountPool.modelCatalog(
			capabilityFreshAfterMs(
				context.cfg.gemini_account_capability_ttl_sec,
				Date.now(),
			),
		);
	} catch (error) {
		log(context.cfg, `model catalog load failed: ${errorLogSummary(error)}`);
		return fallback;
	}
}

export function withAccountPoolAvailability(
	cfg: RuntimeConfig,
	env: WorkerEnv,
): RuntimeConfig {
	if (!d1BindingFromEnv(env)) return cfg;
	return { ...cfg, supports_authenticated_session: true };
}

export function authenticatedSessionRequiredOpenAIResponse(
	reason: GeminiAuthenticatedSessionReason,
): Response {
	return openAIErrorResponse(
		geminiAuthenticatedSessionRequiredMessage(reason),
		GEMINI_AUTHENTICATED_SESSION_REQUIRED_STATUS,
		GEMINI_AUTHENTICATED_SESSION_REQUIRED_CODE,
		reason,
	);
}

export function isMultipartFormRequest(request: Request): boolean {
	const contentType = request.headers.get("content-type") || "";
	return (
		contentType.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data"
	);
}

export function invalidRuntimeConfigResponse(error: unknown): Response {
	if (error instanceof RuntimeConfigError) {
		return jsonResponse(
			{
				error: {
					message: "invalid runtime configuration",
					code: error.code,
					setting: error.setting,
					reason: error.reason,
				},
			},
			500,
		);
	}
	return jsonResponse(
		{
			error: {
				message: "invalid runtime configuration",
				code: "invalid_runtime_config",
			},
		},
		500,
	);
}

export function routeJsonErrorResponse(
	envelope: "google" | undefined,
	parsed: Extract<RouteJsonPostResult, { error: string }>,
): Response {
	if (envelope === "google") {
		return jsonResponse(
			googleErrorResponseBody(parsed.error, parsed.code, parsed.reason),
			parsed.status || 400,
		);
	}
	return openAIErrorResponse(
		parsed.error,
		parsed.status || 400,
		parsed.code,
		parsed.reason,
	);
}
