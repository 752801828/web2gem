import type { CompletionProvider } from "../../completion/ports";
import {
	consumeCompletionStreamEvents,
	streamPlainCompletionEvents,
	streamToolSieveCompletionEvents,
} from "../../completion/stream-events";
import type { RuntimeConfig } from "../../config";
import type { ResolvedModelOk } from "../../models";
import type { FileRef } from "../../completion/types";
import { formatGoogleFunctionCalls } from "../../toolcall/parse";
import { validateGoogleToolPolicyCalls } from "../../toolcall/policy";
import type { ToolChoicePolicy } from "../../toolcall/policy";
import type { ToolBundle } from "../../toolcall/tool-bundle";
import { tokenCountFromCounts } from "../../promptcompat/token-accounting";
import type { SSEWrite } from "../core/sse";
import {
	streamInterruptedWarningText,
	writeStreamWarningEvent,
} from "../core/stream-errors";
import { createDeltaCoalescer } from "../stream/coalescer";
import {
	EMPTY_UPSTREAM_STREAM_ERROR,
	handleCompletionStreamOutcome,
} from "../stream/outcome";
import {
	googleStreamDonePayload,
	writeGoogleCandidate,
	writeGoogleDone,
	writeGoogleStreamError,
} from "./format";

type GooglePlainStreamParams = {
	provider: CompletionProvider;
	prompt: string;
	rm: ResolvedModelOk;
	fileRefs: FileRef[] | null;
	promptTokens: number;
	signal: AbortSignal;
};
type GoogleToolStreamParams = GooglePlainStreamParams & {
	tools: ToolBundle | null;
	toolPolicy: ToolChoicePolicy | null | undefined;
};

export async function streamGooglePlain(
	write: SSEWrite,
	cfg: RuntimeConfig,
	params: GooglePlainStreamParams,
) {
	const { provider, prompt, rm, fileRefs, promptTokens, signal } = params;
	const textCoalescer = createDeltaCoalescer(
		(delta) =>
			write(
				`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: delta.text || "" }], role: "model" }, index: 0 }], modelVersion: rm.name })}\n\n`,
			),
		undefined,
		undefined,
		{ emitFirstImmediately: true },
	);
	const { lifecycle, outcome } = await consumeCompletionStreamEvents(
		streamPlainCompletionEvents(provider, { prompt, rm, fileRefs }, { signal }),
		(text) => textCoalescer.append("text", text),
	);
	await textCoalescer.flush();
	const terminal = await handleCompletionStreamOutcome({
		cfg,
		label: "google stream",
		model: rm.name,
		outcome,
		handlers: {
			onFailedBeforeOutput: (issue) =>
				writeGoogleStreamError(write, rm.name, issue.error),
			onEmpty: () =>
				writeGoogleStreamError(write, rm.name, EMPTY_UPSTREAM_STREAM_ERROR),
			onInterruptedAfterOutput: async (issue) => {
				const warning = `\n\n${streamInterruptedWarningText(issue.error)}`;
				await writeStreamWarningEvent(write, issue.error, warning.trim());
			},
		},
	});
	if (terminal) return;

	const candidateTokens = tokenCountFromCounts(lifecycle.completionCounts);
	await write(
		`data: ${JSON.stringify(googleStreamDonePayload(rm.name, promptTokens, candidateTokens, outcome.type === "interrupted_after_output" ? outcome.issue.error : null))}\n\n`,
	);
}

export async function streamGoogleTools(
	write: SSEWrite,
	cfg: RuntimeConfig,
	params: GoogleToolStreamParams,
) {
	const {
		provider,
		prompt,
		rm,
		fileRefs,
		tools,
		toolPolicy,
		promptTokens,
		signal,
	} = params;
	// Policy is checked on sieve-raw ParsedToolCall[] inside the shared sieve
	// stream; formatGoogleFunctionCalls only shapes the Google wire payload after
	// the stream is accepted (see validateToolCalls on streamToolSieveCompletionEvents).
	const { lifecycle, outcome } = await consumeCompletionStreamEvents(
		streamToolSieveCompletionEvents(
			provider,
			{
				prompt,
				rm,
				fileRefs,
				toolPolicy,
				validateToolCalls: validateGoogleToolPolicyCalls,
			},
			{ signal },
		),
		async (text) => {
			await writeGoogleCandidate(write, rm.name, [{ text }], null);
		},
	);
	const terminal = await handleCompletionStreamOutcome({
		cfg,
		label: "google tool stream",
		model: rm.name,
		outcome,
		// Google tool streams historically omit the "tool " prefix in policy logs.
		policyLogKind: "policy violation",
		handlers: {
			onFailedBeforeOutput: (issue) =>
				writeGoogleStreamError(write, rm.name, issue.error),
			onEmpty: () =>
				writeGoogleStreamError(write, rm.name, EMPTY_UPSTREAM_STREAM_ERROR),
			onPolicyViolation: (violation) =>
				writeGoogleStreamError(write, rm.name, {
					message: violation.message,
					code: violation.code,
				}),
			onInterruptedAfterOutput: (issue) =>
				writeStreamWarningEvent(write, issue.error),
		},
	});
	if (terminal) return;

	const functionCalls = formatGoogleFunctionCalls(lifecycle.toolCalls, tools);
	if (functionCalls.length) {
		await writeGoogleCandidate(
			write,
			rm.name,
			functionCalls.map((fc) => ({
				functionCall: { name: fc.name, args: fc.args || {} },
			})),
			null,
		);
	}
	const candidateTokens = tokenCountFromCounts(lifecycle.completionCounts);
	const promptTokenCount = Math.max(0, Number(promptTokens) || 0);
	await writeGoogleDone(write, rm.name, {
		promptTokenCount,
		candidatesTokenCount: candidateTokens,
		totalTokenCount: promptTokenCount + candidateTokens,
	});
}
