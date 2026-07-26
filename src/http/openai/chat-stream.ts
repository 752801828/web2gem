import type { CompletionProvider } from "../../completion/ports";
import {
	consumeCompletionStreamEvents,
	type CompletionStreamIssue,
	streamPlainCompletionEvents,
	streamToolSieveCompletionEvents,
} from "../../completion/stream-events";
import type { FileRef } from "../../completion/types";
import type { RuntimeConfig } from "../../config";
import type { ResolvedModelOk } from "../../models";
import { errorLogSummary, upstreamErrorCode } from "../../shared/errors";
import { log } from "../../shared/logging";
import {
	combinedTokenCount,
	createTokenCounter,
	tokenCountFromCounts,
} from "../../promptcompat/token-accounting";
import { formatOpenAIStreamToolCalls } from "../../toolcall/parse";
import type { ToolChoicePolicy } from "../../toolcall/policy";
import type { ToolBundle } from "../../toolcall/tool-bundle";
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
	openAIChatChunk,
	writeOpenAIChatStreamError,
	writeOpenAIChatUsageTokenChunk,
} from "./format";

type OpenAIChatChunkWriter = (
	delta: Record<string, unknown>,
	finish: string | null,
) => void | Promise<void>;
type OpenAIChatPlainStreamParams = {
	provider: CompletionProvider;
	id: string;
	model: string;
	prompt: string;
	rm: ResolvedModelOk;
	fileRefs: FileRef[] | null;
	includeUsage: boolean;
	promptTokens: number;
	signal: AbortSignal;
};
type OpenAIChatToolSieveStreamParams = OpenAIChatPlainStreamParams & {
	tools: ToolBundle | null;
	toolPolicy: ToolChoicePolicy | null | undefined;
};

const CHAT_STREAM_LABEL = "openai chat stream";

export async function streamOpenAIChatPlain(
	write: SSEWrite,
	cfg: RuntimeConfig,
	params: OpenAIChatPlainStreamParams,
) {
	const {
		provider,
		id,
		model,
		prompt,
		rm,
		fileRefs,
		includeUsage,
		promptTokens,
		signal,
	} = params;
	const writeChunk = (delta: Record<string, unknown>, finish: string | null) =>
		write(
			`data: ${JSON.stringify(openAIChatChunk(id, model, delta, finish))}\n\n`,
		);
	const deltaCoalescer = createDeltaCoalescer(
		(delta) => writeChunk(delta, null),
		undefined,
		undefined,
		{ emitFirstImmediately: true },
	);
	await writeChunk({ role: "assistant" }, null);

	const { lifecycle, outcome } = await consumeCompletionStreamEvents(
		streamPlainCompletionEvents(provider, { prompt, rm, fileRefs }, { signal }),
		(text) => deltaCoalescer.append("content", text),
	);
	await deltaCoalescer.flush();
	const terminal = await handleCompletionStreamOutcome({
		cfg,
		label: CHAT_STREAM_LABEL,
		model: rm.name,
		outcome,
		handlers: {
			onFailedBeforeOutput: (issue) =>
				writeOpenAIChatStreamError(write, id, model, issue.error),
			onEmpty: () =>
				writeOpenAIChatStreamError(
					write,
					id,
					model,
					EMPTY_UPSTREAM_STREAM_ERROR,
				),
			onInterruptedAfterOutput: (issue) =>
				writeOpenAIChatInterrupted(write, issue),
		},
	});
	if (terminal) return;

	await finishOpenAIChatStream(
		write,
		writeChunk,
		id,
		model,
		includeUsage,
		promptTokens,
		lifecycle.completionCounts,
	);
}

export async function streamOpenAIChatWithToolSieve(
	write: SSEWrite,
	cfg: RuntimeConfig,
	params: OpenAIChatToolSieveStreamParams,
) {
	const {
		provider,
		id,
		model,
		prompt,
		rm,
		fileRefs,
		tools,
		toolPolicy,
		includeUsage,
		promptTokens,
		signal,
	} = params;
	const extraTokenCounter = createTokenCounter();
	const writeChunk = (delta: Record<string, unknown>, finish: string | null) =>
		write(
			`data: ${JSON.stringify(openAIChatChunk(id, model, delta, finish))}\n\n`,
		);
	const deltaCoalescer = createDeltaCoalescer(
		(delta) => writeChunk(delta, null),
		undefined,
		undefined,
		{ emitFirstImmediately: true },
	);
	await writeChunk({ role: "assistant" }, null);

	const { lifecycle, outcome } = await consumeCompletionStreamEvents(
		streamToolSieveCompletionEvents(
			provider,
			{ prompt, rm, fileRefs, toolPolicy },
			{ signal },
		),
		(text) => deltaCoalescer.append("content", text),
	);
	await deltaCoalescer.flush();
	const terminal = await handleCompletionStreamOutcome({
		cfg,
		label: CHAT_STREAM_LABEL,
		model: rm.name,
		outcome,
		// Tool-call interruption uses a specialized log line below.
		logInterrupted: false,
		handlers: {
			onFailedBeforeOutput: (issue) =>
				writeOpenAIChatStreamError(write, id, model, issue.error),
			onEmpty: () =>
				writeOpenAIChatStreamError(
					write,
					id,
					model,
					EMPTY_UPSTREAM_STREAM_ERROR,
				),
			onPolicyViolation: (violation) =>
				writeOpenAIChatStreamError(write, id, model, violation),
			onInterruptedAfterOutput: async (issue) => {
				if (lifecycle.toolCalls?.length) {
					log(
						cfg,
						`${CHAT_STREAM_LABEL} interrupted after tool calls model=${rm.name} code=${upstreamErrorCode(issue.error) || "stream_interrupted"} error=${errorLogSummary(issue.error)}`,
					);
					await writeStreamWarningEvent(write, issue.error);
					return;
				}
				log(
					cfg,
					`${CHAT_STREAM_LABEL} interrupted after partial output model=${rm.name} code=${upstreamErrorCode(issue.error) || "stream_interrupted"} error=${errorLogSummary(issue.error)}`,
				);
				await writeOpenAIChatInterrupted(write, issue);
			},
		},
	});
	if (terminal) return;

	if (lifecycle.toolCalls?.length) {
		const toolCallDeltas = formatOpenAIStreamToolCalls(
			lifecycle.toolCalls,
			new Map(),
			tools,
		);
		await writeChunk({ tool_calls: toolCallDeltas }, "tool_calls");
		extraTokenCounter.append(JSON.stringify(toolCallDeltas));
	} else {
		await writeChunk({}, "stop");
	}
	if (includeUsage)
		await writeOpenAIChatUsageTokenChunk(
			write,
			id,
			model,
			promptTokens,
			combinedTokenCount(lifecycle.completionCounts, extraTokenCounter),
		);
	await write("data: [DONE]\n\n");
}

async function finishOpenAIChatStream(
	write: SSEWrite,
	writeChunk: OpenAIChatChunkWriter,
	id: string,
	model: string,
	includeUsage: boolean,
	promptTokens: number,
	completionCounts: Parameters<typeof tokenCountFromCounts>[0],
): Promise<void> {
	await writeChunk({}, "stop");
	if (includeUsage)
		await writeOpenAIChatUsageTokenChunk(
			write,
			id,
			model,
			promptTokens,
			tokenCountFromCounts(completionCounts),
		);
	await write("data: [DONE]\n\n");
}

async function writeOpenAIChatInterrupted(
	write: SSEWrite,
	issue: CompletionStreamIssue,
): Promise<void> {
	const warning = `\n\n${streamInterruptedWarningText(issue.error)}`;
	await writeStreamWarningEvent(write, issue.error, warning.trim());
}
