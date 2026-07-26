import { isAbortError } from "../shared/abort";
import type { TokenCharCounts } from "../promptcompat/token-accounting";
import {
	createTokenCounter,
	emptyTokenCounts,
} from "../promptcompat/token-accounting";
import type { ParsedToolCall } from "../toolcall/parse";
import type { ToolChoicePolicy, ToolPolicyViolation } from "../toolcall/policy";
import { validateRequiredToolCalls } from "../toolcall/policy";
import {
	createToolSieveState,
	flushToolSieve,
	processToolSieveChunk,
} from "../toolcall/sieve";
import type {
	CompletionProvider,
	CompletionProviderOptions,
	CompletionTextInput,
} from "./ports";

function completionTextDeltas(
	provider: CompletionProvider,
	input: CompletionTextInput,
	options: CompletionProviderOptions,
): AsyncIterable<string> {
	const providerOptions: CompletionProviderOptions = {};
	if (options.signal) providerOptions.signal = options.signal;
	return provider.streamText(input, providerOptions);
}

export type CompletionStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "tool_calls"; toolCalls: ParsedToolCall[] }
	| { type: "tool_policy_violation"; violation: ToolPolicyViolation }
	| { type: "warning"; error: unknown; message: string }
	| { type: "stream_error"; error: unknown; message: string }
	| {
			type: "done";
			emittedText: boolean;
			completionCounts: TokenCharCounts & { hasText: boolean };
	  };

export type CompletionStreamIssue = {
	error: unknown;
	message?: string;
};

type CompletionStreamOutcomeFacts = {
	emittedText: boolean;
	issue: CompletionStreamIssue | null;
	toolCalls: readonly unknown[] | null;
	violation: ToolPolicyViolation | null;
};

export type CompletionStreamOutcome =
	| { type: "failed_before_output"; issue: CompletionStreamIssue }
	| { type: "interrupted_after_output"; issue: CompletionStreamIssue }
	| { type: "policy_violation"; violation: ToolPolicyViolation }
	| { type: "empty" }
	| { type: "ok" };

export type CompletionStreamLifecycle = {
	emittedText: boolean;
	issue: Extract<
		CompletionStreamEvent,
		{ type: "warning" } | { type: "stream_error" }
	> | null;
	toolCalls: ParsedToolCall[] | null;
	violation: ToolPolicyViolation | null;
	completionCounts: TokenCharCounts & { hasText: boolean };
};

function createCompletionStreamLifecycle(): CompletionStreamLifecycle {
	return {
		emittedText: false,
		issue: null,
		toolCalls: null,
		violation: null,
		completionCounts: emptyTokenCounts(),
	};
}

function classifyCompletionStreamOutcome(
	facts: CompletionStreamOutcomeFacts,
): CompletionStreamOutcome {
	const hasVisibleOutput =
		facts.emittedText || Boolean(facts.toolCalls?.length);
	if (facts.issue) {
		return hasVisibleOutput
			? { type: "interrupted_after_output", issue: facts.issue }
			: { type: "failed_before_output", issue: facts.issue };
	}
	if (facts.violation)
		return { type: "policy_violation", violation: facts.violation };
	if (!hasVisibleOutput) return { type: "empty" };
	return { type: "ok" };
}

function recordCompletionStreamEvent(
	lifecycle: CompletionStreamLifecycle,
	event: CompletionStreamEvent,
): void {
	switch (event.type) {
		case "text_delta":
			lifecycle.emittedText ||= !!event.text;
			break;
		case "warning":
		case "stream_error":
			lifecycle.issue = event;
			break;
		case "tool_calls":
			lifecycle.toolCalls = event.toolCalls;
			break;
		case "tool_policy_violation":
			lifecycle.violation = event.violation;
			break;
		case "done":
			lifecycle.emittedText ||= event.emittedText;
			lifecycle.completionCounts = event.completionCounts;
	}
}

/**
 * Shared stream consume shell: record lifecycle events, optional text-delta
 * framing callback, then classify the terminal outcome once.
 */
export async function consumeCompletionStreamEvents(
	events: AsyncIterable<CompletionStreamEvent>,
	onTextDelta?: (text: string) => void | Promise<void>,
): Promise<{
	lifecycle: CompletionStreamLifecycle;
	outcome: CompletionStreamOutcome;
}> {
	const lifecycle = createCompletionStreamLifecycle();
	for await (const event of events) {
		recordCompletionStreamEvent(lifecycle, event);
		if (event.type === "text_delta" && onTextDelta) {
			await onTextDelta(event.text);
		}
	}
	return {
		lifecycle,
		outcome: classifyCompletionStreamOutcome(lifecycle),
	};
}

export async function* streamPlainCompletionEvents(
	provider: CompletionProvider,
	input: CompletionTextInput,
	options: CompletionProviderOptions = {},
): AsyncIterable<CompletionStreamEvent> {
	let emittedText = false;
	let streamErr: unknown = null;
	const completionTokenCounter = createTokenCounter();

	try {
		for await (const delta of completionTextDeltas(provider, input, options)) {
			if (!delta) continue;
			const text = String(delta);
			if (!text) continue;
			emittedText = true;
			completionTokenCounter.append(text);
			yield { type: "text_delta", text };
		}
	} catch (e) {
		if (isAbortError(e)) throw e;
		streamErr = e;
	}

	if (streamErr) {
		yield streamErrorEvent(streamErr, emittedText);
	}
	yield {
		type: "done",
		emittedText,
		completionCounts: completionTokenCounter.counts(),
	};
}

/**
 * Sieved stream for both dialects: pipes provider deltas through the tool
 * sieve, flushes the held tail, then yields tool / policy / done events.
 */
export async function* streamToolSieveCompletionEvents(
	provider: CompletionProvider,
	input: CompletionTextInput & {
		toolPolicy?: ToolChoicePolicy | null | undefined;
		validateToolCalls?: (
			policy: ToolChoicePolicy | null | undefined,
			toolCalls: ParsedToolCall[] | null | undefined,
		) => ToolPolicyViolation | null;
	},
	options: CompletionProviderOptions = {},
): AsyncIterable<CompletionStreamEvent> {
	const state = createToolSieveState();
	const counter = createTokenCounter();
	let emittedText = false;
	let streamErr: unknown = null;

	try {
		for await (const deltaText of completionTextDeltas(
			provider,
			input,
			options,
		)) {
			for (const text of processToolSieveChunk(state, deltaText)) {
				if (!text) continue;
				emittedText = true;
				counter.append(text);
				yield { type: "text_delta", text };
			}
		}
	} catch (e) {
		if (isAbortError(e)) throw e;
		streamErr = e;
	}

	const flushed = flushToolSieve(state);
	if (flushed.text) {
		emittedText = true;
		counter.append(flushed.text);
		yield { type: "text_delta", text: flushed.text };
	}
	const toolCalls = flushed.toolCalls;
	const validateToolCalls =
		input.validateToolCalls || validateRequiredToolCalls;
	const violation = streamErr
		? null
		: validateToolCalls(input.toolPolicy, toolCalls);

	if (streamErr)
		yield streamErrorEvent(streamErr, emittedText || !!toolCalls?.length);
	if (violation) yield { type: "tool_policy_violation", violation };
	if (toolCalls?.length) yield { type: "tool_calls", toolCalls };
	yield {
		type: "done",
		emittedText,
		completionCounts: counter.counts(),
	};
}

function streamErrorEvent(
	error: unknown,
	afterPartialOutput: boolean,
): CompletionStreamEvent {
	return {
		type: afterPartialOutput ? "warning" : "stream_error",
		error,
		message: errorMessage(error),
	};
}

function errorMessage(error: unknown): string {
	return String(
		error && typeof error === "object" && "message" in error
			? (error as { message?: unknown }).message
			: error,
	);
}
