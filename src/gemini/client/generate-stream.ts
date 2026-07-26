import type { RuntimeConfig } from "../../config";
import { throwIfAborted } from "../../shared/abort";
import { log } from "../../shared/logging";
import { cancelResponseBody } from "../transport/http";
import {
	geminiSemanticError,
	invalidGeminiCookieError,
	upstreamEmptyResponseError,
} from "./errors";
import {
	fetchGeminiStreamGenerate,
	resolveEmptyUpstream,
} from "./generate-core";
import { wrbResponseShapeSummary } from "./parse-envelope";
import { extractResponseFatalCode, extractResponseText } from "./parse-parts";
import {
	CONTINUE_SAME_ACCOUNT_ATTEMPT,
	type GeminiFileRef,
	runSameAccountStreamAttempts,
} from "./generate-core";
import { consumeGeminiWrbStream } from "./stream-consumer";

type GeminiStreamOptions = {
	signal?: AbortSignal;
};

export async function* generateStream(
	cfg: RuntimeConfig,
	prompt: string,
	modelNumber: number,
	extended: boolean,
	fileRefs: GeminiFileRef[] | null | undefined,
	options: GeminiStreamOptions = {},
	modelHeaders: Record<string, string> | null = null,
): AsyncIterable<string> {
	const signal = options?.signal;
	yield* runSameAccountStreamAttempts({
		cfg,
		prompt,
		modelNumber,
		extended,
		fileRefs,
		label: "Stream retry",
		signal,
		async *execute({ attemptState, body, requestId, signal: attemptSignal }) {
			throwIfAborted(attemptSignal);
			const resp = await fetchGeminiStreamGenerate(
				cfg,
				attemptState.activeConfig,
				body,
				attemptSignal,
				modelHeaders,
				requestId,
			);
			const cookieErr = invalidGeminiCookieError(cfg, resp.status);
			if (cookieErr) {
				await cancelResponseBody(resp);
				throw cookieErr;
			}
			if (!resp.body) {
				const raw = await resp.text();
				const fatalCode = extractResponseFatalCode(raw);
				if (fatalCode) throw geminiSemanticError("stream_generate", fatalCode);
				const text = extractResponseText(raw);
				if (text) {
					attemptState.markOutputStarted();
					yield text;
				}
				if (!text) {
					const shape = cfg.log_requests
						? ` ${wrbResponseShapeSummary(raw)}`
						: "";
					log(
						cfg,
						`stream upstream produced no text without body (status=${resp.status}) rawLen=${raw.length}${shape}`,
					);
					const decision = await resolveEmptyUpstream({
						cfg,
						prompt,
						raw,
						status: resp.status,
						fileRefs,
						rawLength: raw.length,
						tryRefreshBuildLabel: (label) =>
							attemptState.tryRefreshBuildLabel(label),
						refreshLabel: "stream without body",
						finalError: (status, rawLen) =>
							upstreamEmptyResponseError(status, rawLen, "stream without body"),
					});
					if (decision.kind === "continue")
						return CONTINUE_SAME_ACCOUNT_ATTEMPT;
					throw decision.error;
				}
				return;
			}
			let rawSnippet = "";
			let rawLength = 0;
			for await (const event of consumeGeminiWrbStream(
				resp.body,
				attemptSignal,
			)) {
				if (event.type === "delta") {
					attemptState.markOutputStarted();
					yield event.text;
				} else {
					rawSnippet = event.rawSnippet;
					rawLength = event.rawLength;
				}
			}
			if (!attemptState.outputStarted) {
				const shape = cfg.log_requests
					? ` ${wrbResponseShapeSummary(rawSnippet)}`
					: "";
				log(
					cfg,
					`stream upstream produced no text (status=${resp.status}) rawLen=${rawLength}${shape}`,
				);
				const decision = await resolveEmptyUpstream({
					cfg,
					prompt,
					raw: rawSnippet,
					status: resp.status,
					fileRefs,
					rawLength: null,
					tryRefreshBuildLabel: (label) =>
						attemptState.tryRefreshBuildLabel(label),
					refreshLabel: "stream",
					finalError: (status, _rawLen) =>
						upstreamEmptyResponseError(status, rawLength, "stream"),
				});
				if (decision.kind === "continue") return CONTINUE_SAME_ACCOUNT_ATTEMPT;
				throw decision.error;
			}
			return undefined;
		},
	});
}
