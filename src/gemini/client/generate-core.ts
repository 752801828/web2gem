import type { RuntimeConfig } from "../../config";
import { abortError, isAbortError } from "../../shared/abort";
import { uuid } from "../../shared/crypto";
import { log } from "../../shared/logging";
import type { ErrorWithMetadata } from "../../shared/types";
import {
	configWithFreshGeminiCookie,
	observeGeminiAccountResponseCookies,
	rotateGeminiCookieForRetryWithReason,
} from "../cookies";
import { httpFetch } from "../transport/http";
import { getPageTokens } from "../uploads/tokens";
import {
	dataAnalysisEmptyResponseError,
	invalidGeminiCookieError,
	isDataAnalysisEmptyResponseError,
	isGeminiSemanticError,
	isInvalidGeminiCookieError,
	isLargePromptEmptyResponseError,
	largePromptEmptyResponseError,
	largePromptEmptyResponseThreshold,
	shouldRetryGeminiSemanticErrorOnSameAccount,
	unverifiedGeminiCookieError,
} from "./errors";
import { buildHeaders, buildPayload, getUrl } from "./protocol";
import {
	configWithCachedGeminiBuildLabel,
	refreshGeminiBuildLabelForRetry,
	waitBeforeRetry,
} from "./retry";

type ErrorRecoveryOptions = {
	attempt: number;
	label: string;
	signal?: AbortSignal | null | undefined;
};

export type SameAccountAttemptState = {
	readonly activeConfig: RuntimeConfig;
	readonly lastError: unknown;
	readonly outputStarted: boolean;
	markOutputStarted(): void;
	tryRefreshBuildLabel(context: string): Promise<boolean>;
	recoverFromError(
		error: unknown,
		options: ErrorRecoveryOptions,
	): Promise<boolean>;
};

export async function createSameAccountAttemptState(
	cfg: RuntimeConfig,
): Promise<SameAccountAttemptState> {
	let activeConfig = await configWithCachedGeminiBuildLabel(
		await configWithFreshGeminiCookie(cfg),
	);
	let buildLabelRefreshed = false;
	let cookieRefreshed = false;
	let lastError: unknown;
	let outputStarted = false;

	return {
		get activeConfig() {
			return activeConfig;
		},
		get lastError() {
			return lastError;
		},
		get outputStarted() {
			return outputStarted;
		},
		markOutputStarted() {
			outputStarted = true;
		},
		async tryRefreshBuildLabel(context) {
			if (outputStarted) return false;
			const refreshedConfig = await refreshGeminiBuildLabelForRetry(
				cfg,
				activeConfig,
				buildLabelRefreshed,
				context,
			);
			if (!refreshedConfig) return false;
			buildLabelRefreshed = true;
			activeConfig = refreshedConfig;
			return true;
		},
		async recoverFromError(error, { attempt, label, signal }) {
			if (isAbortError(error) || signal?.aborted) throw abortError(signal);
			if (
				isInvalidGeminiCookieError(error) &&
				!outputStarted &&
				!cookieRefreshed
			) {
				const rotated =
					await rotateGeminiCookieForRetryWithReason(activeConfig);
				if (rotated.config) {
					cookieRefreshed = true;
					activeConfig = await configWithCachedGeminiBuildLabel(rotated.config);
					return true;
				}
				throw invalidCookieErrorWithRotationReason(cfg, error, rotated.reason);
			}
			if (
				isInvalidGeminiCookieError(error) &&
				!outputStarted &&
				cookieRefreshed
			) {
				throw invalidCookieErrorWithRotationReason(
					cfg,
					error,
					"rotation_updated",
				);
			}
			if (
				isLargePromptEmptyResponseError(error) ||
				isDataAnalysisEmptyResponseError(error) ||
				isInvalidGeminiCookieError(error) ||
				(isGeminiSemanticError(error) &&
					!shouldRetryGeminiSemanticErrorOnSameAccount(error))
			) {
				throw error;
			}
			lastError = error;
			if (outputStarted) throw error;
			return waitBeforeRetry(cfg, attempt, error, label, signal);
		},
	};
}

function invalidCookieErrorWithRotationReason(
	cfg: RuntimeConfig,
	error: unknown,
	reason: unknown,
): unknown {
	const meta =
		error && typeof error === "object"
			? (error as Partial<ErrorWithMetadata>)
			: {};
	return (
		invalidGeminiCookieError(
			cfg,
			meta.upstreamStatus || meta.status || 401,
			typeof meta.rawLength === "number" ? meta.rawLength : null,
			reason,
		) || error
	);
}

/** Sentinel returned by attempt execute bodies to retry the same account loop. */
export const CONTINUE_SAME_ACCOUNT_ATTEMPT = Symbol(
	"CONTINUE_SAME_ACCOUNT_ATTEMPT",
);
export type ContinueSameAccountAttempt = typeof CONTINUE_SAME_ACCOUNT_ATTEMPT;

/** Shared Gemini file-ref shape for client generate / stream payloads. */
export type GeminiFileRef =
	| string
	| {
			ref?: unknown;
			fileRef?: unknown;
			id?: unknown;
			name?: unknown;
			filename?: unknown;
	  };

export type SameAccountGenerateContext = {
	attemptState: SameAccountAttemptState;
	body: string;
	requestId: string;
	attempt: number;
	signal: AbortSignal | null | undefined;
};

type SameAccountGenerateBaseArgs = {
	cfg: RuntimeConfig;
	prompt: string;
	modelNumber: number;
	extended: boolean;
	fileRefs: GeminiFileRef[] | null | undefined;
	label: string;
	signal?: AbortSignal | null | undefined;
};

/**
 * Shared same-account retry shell for non-stream generate / generateRich.
 * Mode-specific parse, empty handling, and hydration stay in the execute body.
 */
export async function runSameAccountGenerateAttempts<T>(
	args: SameAccountGenerateBaseArgs & {
		execute: (
			ctx: SameAccountGenerateContext,
		) => Promise<T | ContinueSameAccountAttempt>;
	},
): Promise<T> {
	const attemptState = await createSameAccountAttemptState(args.cfg);
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		args.prompt,
		args.modelNumber,
		args.extended,
		args.fileRefs || null,
		requestId,
	);
	const signal = args.signal;

	for (let attempt = 0; attempt < args.cfg.retry_attempts; attempt++) {
		try {
			const result = await args.execute({
				attemptState,
				body,
				requestId,
				attempt,
				signal,
			});
			if (result === CONTINUE_SAME_ACCOUNT_ATTEMPT) continue;
			return result;
		} catch (e) {
			if (
				await attemptState.recoverFromError(e, {
					attempt,
					label: args.label,
					signal,
				})
			)
				continue;
			throw e;
		}
	}
	throw attemptState.lastError;
}

/**
 * Shared same-account retry shell for generateStream.
 * Yields provider deltas from execute; return CONTINUE to retry without output.
 */
export async function* runSameAccountStreamAttempts(
	args: SameAccountGenerateBaseArgs & {
		execute: (
			ctx: SameAccountGenerateContext,
		) => AsyncGenerator<string, undefined | ContinueSameAccountAttempt>;
	},
): AsyncGenerator<string> {
	const attemptState = await createSameAccountAttemptState(args.cfg);
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		args.prompt,
		args.modelNumber,
		args.extended,
		args.fileRefs || null,
		requestId,
	);
	const signal = args.signal;

	for (let attempt = 0; attempt < args.cfg.retry_attempts; attempt++) {
		try {
			const result = yield* args.execute({
				attemptState,
				body,
				requestId,
				attempt,
				signal,
			});
			if (result === CONTINUE_SAME_ACCOUNT_ATTEMPT) continue;
			return;
		} catch (e) {
			if (
				await attemptState.recoverFromError(e, {
					attempt,
					label: args.label,
					signal,
				})
			)
				continue;
			throw e;
		}
	}
	if (attemptState.lastError) throw attemptState.lastError;
}

type EmptyUpstreamDecision =
	| { kind: "throw"; error: Error }
	| { kind: "continue" };

/**
 * Shared empty-upstream resolution for generate / generateRich / generateStream.
 * Order is fixed: data-analysis → large-prompt → build-label continue → final error.
 */
export async function resolveEmptyUpstream(args: {
	cfg: RuntimeConfig;
	prompt: string;
	raw: string;
	status: number;
	fileRefs: GeminiFileRef[] | null | undefined;
	rawLength: number | null;
	tryRefreshBuildLabel: (label: string) => Promise<boolean>;
	refreshLabel: string;
	finalError: (status: number, rawLen: number | null) => Error;
}): Promise<EmptyUpstreamDecision> {
	const dataAnalysisErr = dataAnalysisEmptyResponseError(
		args.raw,
		args.fileRefs,
	);
	if (dataAnalysisErr) return { kind: "throw", error: dataAnalysisErr };
	const largePromptErr = largePromptEmptyResponseError(
		args.prompt,
		args.status,
		args.rawLength,
		largePromptEmptyResponseThreshold(args.cfg),
	);
	if (largePromptErr) return { kind: "throw", error: largePromptErr };
	if (await args.tryRefreshBuildLabel(args.refreshLabel))
		return { kind: "continue" };
	return {
		kind: "throw",
		error: args.finalError(args.status, args.rawLength),
	};
}

export async function appendGeminiPageToken(
	cfg: RuntimeConfig,
	body: string,
): Promise<string> {
	if (!cfg.cookie) return body;
	const tokens = await getPageTokens(cfg);
	if (!tokens.at) {
		log(cfg, "gemini cookie verification failed reason=missing_page_at_token");
		throw unverifiedGeminiCookieError("missing_page_at_token");
	}
	return `${body}&at=${encodeURIComponent(tokens.at)}`;
}

export async function fetchGeminiStreamGenerate(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	body: string,
	signal: AbortSignal | null | undefined = undefined,
	modelHeaders: Record<string, string> | null = null,
	requestId: string | null = null,
) {
	const url = getUrl(activeCfg);
	const headers = await buildHeaders(activeCfg, modelHeaders, requestId);
	const requestBody = await appendGeminiPageToken(activeCfg, body);
	const response = await httpFetch(url, {
		method: "POST",
		headers,
		body: requestBody,
		timeoutMs: cfg.request_timeout_sec * 1000,
		socket: cfg.upstream_socket,
		socketFallback: "never",
		signal,
		cfg,
	});
	observeGeminiAccountResponseCookies(activeCfg, response);
	return response;
}
