import {
	applicationModelCatalog,
	authenticatedSessionRequiredOpenAIResponse,
	invalidRuntimeConfigResponse,
	isMultipartFormRequest,
	routeJsonErrorResponse,
	withAccountPoolAvailability,
} from "./app-support";
import { createRuntimeConfig, getConfig } from "./config";
import { authorized } from "./http/core/auth";
import { corsHeaders, withCORS, withHeaders } from "./http/core/cors";
import { jsonResponse, jsonTextResponse } from "./http/core/json";
import { openAIErrorResponse } from "./http/openai/errors";
import { handleChat } from "./http/openai/chat";
import {
	handleImageEdits,
	handleImageEditsMultipart,
	handleImageGenerations,
} from "./http/openai/images";
import { handleResponses } from "./http/openai/responses";
import { handleGoogleGenerate } from "./http/google/handlers";
import {
	type GoogleGenerationRoute,
	parseGoogleGenerationPath,
} from "./http/google/model-path";
import {
	googleModelDetailJson,
	googleModelListJson,
} from "./http/google/models";
import {
	openAIModelDetailJson,
	openAIModelListJson,
} from "./http/openai/models";
import { readRouteJsonPost } from "./http/route-body";
import {
	handleGeminiAccountAdminRequest,
	isGeminiAccountAdminPath,
} from "./http/admin/gemini-accounts";
import {
	handleGeminiAccountAdminUiRequest,
	isGeminiAccountAdminUiPath,
} from "./http/admin/gemini-account-webui";
import {
	handleGeminiModelRoutingAdminRequest,
	isGeminiModelRoutingAdminPath,
} from "./http/admin/gemini-model-routing";
import { createGeminiCompletionProvider } from "./gemini/completion-provider";
import type { GeminiAuthenticatedSessionReason } from "./shared/errors";
import { getGeminiAccountPoolFromEnv } from "./gemini/accounts/runtime";
import { elapsedMs, log, logStage, nowMs } from "./shared/logging";
import { errorLogSummary } from "./shared/errors";
import { uuid } from "./shared/crypto";
import type { RuntimeConfig, WorkerEnv } from "./config";
import type { AccountPoolService } from "./gemini/accounts/pool";
import type { UnknownRecord } from "./shared/types";
import { MODELS } from "./models";
import { VERSION } from "./config";

const HEALTH_JSON = JSON.stringify({
	status: "ok",
	version: VERSION,
	models: Object.keys(MODELS),
});
const NOT_FOUND_JSON = JSON.stringify({ error: "not found" });

export type ApplicationExecutionContext = Pick<
	ExecutionContext,
	"waitUntil"
> & {
	runtimeProfile?: "docker";
};

type ApplicationRequestContext = {
	request: Request;
	env: WorkerEnv;
	cfg: RuntimeConfig;
	url: URL;
	path: string;
};

// One declarative route table replaces the former per-method if-chains,
// admin is*Path pairs, and per-envelope JSON-post wrappers. Order matters:
// "exempt" routes run before the public auth gate (admin auth policy is
// owned by their handlers), "public" routes run after it.
type AppRouteContext = ApplicationRequestContext & {
	body?: UnknownRecord;
	accountPool: AccountPoolService | null;
};

type AppRoute<P> = {
	method?: "GET" | "POST";
	access: "exempt" | "public";
	match: (path: string) => P | null;
	when?: (request: Request) => boolean;
	body?: "json";
	envelope?: "google";
	requiresSession?: GeminiAuthenticatedSessionReason;
	handle: (ctx: AppRouteContext, params: P) => Promise<Response> | Response;
};

function route<P>(definition: AppRoute<P>): AppRoute<unknown> {
	return definition as AppRoute<unknown>;
}

const matchExact = (target: string) => (path: string) =>
	path === target ? {} : null;
const matchIdSuffix = (prefix: string) => (path: string) => {
	if (!path.startsWith(prefix)) return null;
	try {
		const id = decodeURIComponent(path.slice(prefix.length));
		return id ? { id } : null;
	} catch {
		return null;
	}
};
const matchPredicate =
	(predicate: (path: string) => boolean) => (path: string) =>
		predicate(path) ? {} : null;

const APP_ROUTES: readonly AppRoute<unknown>[] = [
	route({
		access: "exempt",
		match: matchPredicate(isGeminiAccountAdminUiPath),
		handle: ({ request }) => handleGeminiAccountAdminUiRequest(request),
	}),
	route({
		access: "exempt",
		match: matchPredicate(isGeminiAccountAdminPath),
		handle: ({ request, env, cfg, url }) =>
			handleGeminiAccountAdminRequest(request, env, cfg, url),
	}),
	route({
		access: "exempt",
		match: matchPredicate(isGeminiModelRoutingAdminPath),
		handle: ({ request, env, cfg, url }) =>
			handleGeminiModelRoutingAdminRequest(request, env, cfg, url),
	}),
	route({
		method: "GET",
		access: "public",
		match: matchExact("/"),
		handle: () => jsonTextResponse(HEALTH_JSON),
	}),
	route({
		method: "GET",
		access: "public",
		match: matchExact("/v1/models"),
		handle: async (ctx) =>
			jsonTextResponse(openAIModelListJson(await applicationModelCatalog(ctx))),
	}),
	route({
		method: "GET",
		access: "public",
		match: matchIdSuffix("/v1/models/"),
		handle: async (ctx, { id }: { id: string }) => {
			const modelJson = openAIModelDetailJson(
				await applicationModelCatalog(ctx),
				id,
			);
			if (!modelJson)
				return openAIErrorResponse(
					`model ${id} is not available`,
					404,
					"model_not_found",
				);
			return jsonTextResponse(modelJson);
		},
	}),
	route({
		method: "GET",
		access: "public",
		match: matchExact("/v1beta/models"),
		handle: async (ctx) =>
			jsonTextResponse(googleModelListJson(await applicationModelCatalog(ctx))),
	}),
	route({
		method: "GET",
		access: "public",
		match: matchIdSuffix("/v1beta/models/"),
		handle: async (ctx, { id }: { id: string }) => {
			const modelJson = googleModelDetailJson(
				await applicationModelCatalog(ctx),
				id,
			);
			if (!modelJson)
				return jsonResponse(
					{
						error: {
							message: `model ${id} is not available`,
							code: "model_not_found",
						},
					},
					404,
				);
			return jsonTextResponse(modelJson);
		},
	}),
	route({
		method: "POST",
		access: "public",
		match: matchExact("/v1/chat/completions"),
		body: "json",
		handle: ({ body, cfg, accountPool }) =>
			handleChat(body as UnknownRecord, cfg, createProvider(cfg, accountPool)),
	}),
	route({
		method: "POST",
		access: "public",
		match: matchExact("/v1/responses"),
		body: "json",
		handle: ({ body, cfg, accountPool }) =>
			handleResponses(body, cfg, createProvider(cfg, accountPool)),
	}),
	route({
		method: "POST",
		access: "public",
		match: matchExact("/v1/images/generations"),
		body: "json",
		requiresSession: "image",
		handle: ({ body, cfg, accountPool }) =>
			handleImageGenerations(
				body as UnknownRecord,
				cfg,
				createProvider(cfg, accountPool),
			),
	}),
	route({
		method: "POST",
		access: "public",
		match: matchExact("/v1/images/edits"),
		when: isMultipartFormRequest,
		requiresSession: "image",
		handle: ({ request, cfg, accountPool }) =>
			handleImageEditsMultipart(request, cfg, createProvider(cfg, accountPool)),
	}),
	route({
		method: "POST",
		access: "public",
		match: matchExact("/v1/images/edits"),
		body: "json",
		requiresSession: "image",
		handle: ({ body, cfg, accountPool }) =>
			handleImageEdits(
				body as UnknownRecord,
				cfg,
				createProvider(cfg, accountPool),
			),
	}),
	route({
		method: "POST",
		access: "public",
		match: parseGoogleGenerationPath,
		body: "json",
		envelope: "google",
		handle: ({ body, cfg, accountPool }, googleRoute) =>
			handleGoogleGenerate(
				body as UnknownRecord,
				cfg,
				createProvider(cfg, accountPool),
				googleRoute as GoogleGenerationRoute,
			),
	}),
];

export async function handleApplicationRequest(
	request: Request,
	env: WorkerEnv,
	executionContext: ApplicationExecutionContext,
): Promise<Response> {
	const method = request.method.toUpperCase();
	const url = new URL(request.url);
	const path = url.pathname;
	const requestId = uuid();
	let activeConfig: RuntimeConfig | undefined;
	let requestStartMs = 0;
	const respond = (response: Response) => {
		const corsResponse = withCORS(response, request);
		const completed = withHeaders(corsResponse, [["x-request-id", requestId]]);
		if (activeConfig?.log_requests) {
			logStage(activeConfig, "request_complete", {
				requestId,
				method,
				path,
				status: completed.status,
				ms: elapsedMs(requestStartMs),
			});
		}
		return completed;
	};

	if (method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: corsHeaders(request),
		});
	}

	let cfg: RuntimeConfig;
	try {
		cfg = withAccountPoolAvailability(
			createRuntimeConfig(getConfig(env), {
				execution_ctx: executionContext,
				runtime_profile:
					executionContext.runtimeProfile === "docker" ? "docker" : "worker",
			}),
			env,
		);
		activeConfig = cfg;
		if (cfg.log_requests) requestStartMs = nowMs();
	} catch (error) {
		return respond(invalidRuntimeConfigResponse(error));
	}

	const context: ApplicationRequestContext = {
		request,
		env,
		cfg,
		url,
		path,
	};

	const exempt = matchApplicationRoute("exempt", method, context);
	if (exempt) {
		return respond(
			await runApplicationRoute(exempt.route, exempt.params, context),
		);
	}

	if (path !== "/" && !authorized(request, url, cfg)) {
		return respond(openAIErrorResponse("invalid api key", 401));
	}

	try {
		const matched = matchApplicationRoute("public", method, context);
		const response = matched
			? await runApplicationRoute(matched.route, matched.params, context)
			: jsonTextResponse(NOT_FOUND_JSON, 404);
		return respond(response);
	} catch (error) {
		log(cfg, `error: ${errorLogSummary(error)}`);
		return respond(
			jsonResponse(
				{
					error: {
						message: "internal server error",
						code: "internal_server_error",
					},
				},
				500,
			),
		);
	}
}

function matchApplicationRoute(
	access: "exempt" | "public",
	method: string,
	context: ApplicationRequestContext,
): { route: AppRoute<unknown>; params: unknown } | null {
	for (const candidate of APP_ROUTES) {
		if (candidate.access !== access) continue;
		if (candidate.method && candidate.method !== method) continue;
		if (candidate.when && !candidate.when(context.request)) continue;
		const params = candidate.match(context.path);
		if (params !== null) return { route: candidate, params };
	}
	return null;
}

async function runApplicationRoute(
	matched: AppRoute<unknown>,
	params: unknown,
	context: ApplicationRequestContext,
): Promise<Response> {
	const { request, cfg, env, path } = context;
	let body: UnknownRecord | undefined;
	if (matched.body === "json") {
		const parsed = await readRouteJsonPost(request, cfg, path);
		if (parsed.error !== undefined)
			return routeJsonErrorResponse(matched.envelope, parsed);
		body = parsed.value;
	}
	let accountPool: AccountPoolService | null = null;
	if (matched.body === "json" || matched.requiresSession) {
		accountPool = getGeminiAccountPoolFromEnv(env);
		if (matched.requiresSession && !accountPool)
			return authenticatedSessionRequiredOpenAIResponse(
				matched.requiresSession,
			);
	}
	const routeContext: AppRouteContext = { ...context, accountPool };
	if (body !== undefined) routeContext.body = body;
	return matched.handle(routeContext, params);
}

function createProvider(
	cfg: RuntimeConfig,
	accountPool: AccountPoolService | null,
) {
	return createGeminiCompletionProvider(cfg, { accountPool });
}
