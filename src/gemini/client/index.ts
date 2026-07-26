import type { RuntimeConfig } from "../../config";
import { log } from "../../shared/logging";
import { cancelResponseBody } from "../transport/http";
import {
	geminiSemanticError,
	invalidGeminiCookieError,
	upstreamEmptyResponseError,
	upstreamImageGenerationEmptyError,
	upstreamImageProviderError,
} from "./errors";
import type { GeminiRichImage } from "./generated-images";
import { hydrateGeneratedImages } from "./generated-images";
import {
	fetchGeminiStreamGenerate,
	resolveEmptyUpstream,
} from "./generate-core";
import { wrbResponseShapeSummary } from "./parse-envelope";
import {
	extractResponseFatalCode,
	extractResponseParts,
	extractResponseText,
	richResponseShapeSummary,
} from "./parse-parts";
import type { SameAccountAttemptState } from "./generate-core";
import {
	CONTINUE_SAME_ACCOUNT_ATTEMPT,
	type GeminiFileRef,
	runSameAccountGenerateAttempts,
} from "./generate-core";

export { generateStream } from "./generate-stream";

type GeminiRichOptions = {
	hydrateGeneratedImageBytes?: boolean;
};

export type { GeminiRichImage } from "./generated-images";

export type GeminiRichOutput = {
	text: string;
	images: GeminiRichImage[];
};

type NonStreamParseResult<T> =
	| { kind: "value"; value: T }
	| { kind: "empty"; raw: string; status: number }
	| { kind: "throw"; error: Error };

/**
 * Shared non-stream shell for generate / generateRich.
 * Owns fetch, cookie status check, body text, and empty-upstream resolution.
 * Mode-specific parse and final empty errors stay in the strategies.
 */
async function runNonStreamGeminiGenerate<T>(args: {
	cfg: RuntimeConfig;
	prompt: string;
	modelNumber: number;
	extended: boolean;
	fileRefs: GeminiFileRef[] | null | undefined;
	modelHeaders: Record<string, string> | null;
	label: string;
	parse: (
		raw: string,
		resp: { ok: boolean; status: number },
	) => NonStreamParseResult<T> | Promise<NonStreamParseResult<T>>;
	emptyFinalError: (status: number, rawLen: number | null) => Error;
	refreshLabel?: string;
	afterValue?: (
		value: T,
		attemptState: SameAccountAttemptState,
	) => Promise<T> | T;
}): Promise<T> {
	return runSameAccountGenerateAttempts({
		cfg: args.cfg,
		prompt: args.prompt,
		modelNumber: args.modelNumber,
		extended: args.extended,
		fileRefs: args.fileRefs,
		label: args.label,
		async execute({ attemptState, body, requestId }) {
			const resp = await fetchGeminiStreamGenerate(
				args.cfg,
				attemptState.activeConfig,
				body,
				undefined,
				args.modelHeaders,
				requestId,
			);
			const cookieErr = invalidGeminiCookieError(args.cfg, resp.status);
			if (cookieErr) {
				await cancelResponseBody(resp);
				throw cookieErr;
			}
			const raw = await resp.text();
			const parsed = await args.parse(raw, resp);
			if (parsed.kind === "throw") throw parsed.error;
			if (parsed.kind === "empty") {
				const decision = await resolveEmptyUpstream({
					cfg: args.cfg,
					prompt: args.prompt,
					raw: parsed.raw,
					status: parsed.status,
					fileRefs: args.fileRefs,
					rawLength: parsed.raw.length,
					tryRefreshBuildLabel: (label) =>
						attemptState.tryRefreshBuildLabel(label),
					refreshLabel: args.refreshLabel || "",
					finalError: args.emptyFinalError,
				});
				if (decision.kind === "continue") return CONTINUE_SAME_ACCOUNT_ATTEMPT;
				throw decision.error;
			}
			if (args.afterValue) return args.afterValue(parsed.value, attemptState);
			return parsed.value;
		},
	});
}

export async function generate(
	cfg: RuntimeConfig,
	prompt: string,
	modelNumber: number,
	extended: boolean,
	fileRefs: GeminiFileRef[] | null | undefined,
	modelHeaders: Record<string, string> | null = null,
): Promise<string> {
	return runNonStreamGeminiGenerate({
		cfg,
		prompt,
		modelNumber,
		extended,
		fileRefs,
		modelHeaders,
		label: "Retry",
		parse(raw, resp) {
			const fatalCode = extractResponseFatalCode(raw);
			if (fatalCode) {
				return {
					kind: "throw",
					error: geminiSemanticError("stream_generate", fatalCode),
				};
			}
			const text = extractResponseText(raw);
			if (!resp.ok || !text) {
				const shape =
					cfg.log_requests && !text ? ` ${wrbResponseShapeSummary(raw)}` : "";
				log(
					cfg,
					`upstream status=${resp.status} rawLen=${raw.length} parsedLen=${text.length}${shape}`,
				);
			}
			if (!text) return { kind: "empty", raw, status: resp.status };
			return { kind: "value", value: text };
		},
		emptyFinalError: (status, rawLen) =>
			upstreamEmptyResponseError(status, rawLen, "non-stream"),
	});
}

export async function generateRich(
	cfg: RuntimeConfig,
	prompt: string,
	modelNumber: number,
	extended: boolean,
	fileRefs: GeminiFileRef[] | null | undefined,
	modelHeaders: Record<string, string> | null = null,
	options: GeminiRichOptions = {},
): Promise<GeminiRichOutput> {
	return runNonStreamGeminiGenerate({
		cfg,
		prompt,
		modelNumber,
		extended,
		fileRefs,
		modelHeaders,
		label: "Rich retry",
		parse(raw, resp) {
			const parts = extractResponseParts(raw);
			if (parts.fatalCode) {
				return {
					kind: "throw",
					error: upstreamImageProviderError(parts.fatalCode),
				};
			}
			if (!resp.ok || (!parts.text && !parts.images.length)) {
				const shape = cfg.log_requests
					? ` ${richResponseShapeSummary(raw)}`
					: "";
				log(
					cfg,
					`rich upstream status=${resp.status} rawLen=${raw.length} parsedTextLen=${parts.text.length} images=${parts.images.length}${shape}`,
				);
			}
			if (!parts.text && !parts.images.length) {
				return { kind: "empty", raw, status: resp.status };
			}
			return {
				kind: "value",
				value: { text: parts.text, images: parts.images },
			};
		},
		emptyFinalError: (status, rawLen) =>
			upstreamImageGenerationEmptyError(status, rawLen, "non-stream"),
		afterValue: async (value, attemptState) => {
			const images =
				options.hydrateGeneratedImageBytes === false
					? value.images
					: await hydrateGeneratedImages(
							cfg,
							attemptState.activeConfig,
							value.images,
						);
			return { text: value.text, images };
		},
	});
}
