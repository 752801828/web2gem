import { describe, test } from "vitest";
import type { CompletionProvider } from "../../src/completion/ports";
import {
	type CompletionStreamEvent,
	consumeCompletionStreamEvents,
	streamPlainCompletionEvents,
	streamToolSieveCompletionEvents,
} from "../../src/completion/stream-events";
import { tokenCountFromCounts } from "../../src/promptcompat/token-accounting";
import { type ErrorWithMetadata, isRecord } from "../../src/shared/types";
import type { ToolChoicePolicy } from "../../src/toolcall/policy";
import { chunks } from "./_support/async-stream.js";
import { assert } from "./assertions.js";
import { resolvedModel, strictProvider } from "./http/_support/provider.js";

function required<T>(value: T | null | undefined, message: string): T {
	if (value === null || value === undefined) throw new Error(message);
	return value;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (isRecord(error) && typeof error.message === "string")
		return error.message;
	return String(error);
}

function firstTextEvent(
	events: readonly CompletionStreamEvent[],
): Extract<CompletionStreamEvent, { type: "text_delta" }> {
	const event = events.find(
		(
			candidate,
		): candidate is Extract<CompletionStreamEvent, { type: "text_delta" }> =>
			candidate.type === "text_delta",
	);
	return required(event, "expected text delta event");
}

async function collectEvents<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

function abortingAsyncIterable<T>(error: unknown): AsyncIterable<T> {
	return {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					throw error;
				},
			};
		},
	};
}
function streamProvider(deltas: AsyncIterable<unknown>): CompletionProvider {
	return strictProvider({
		streamText() {
			return (async function* normalizeDeltas() {
				for await (const delta of deltas) {
					if (delta !== null && delta !== undefined) yield String(delta);
				}
			})();
		},
	});
}

async function consumeCompletionEvents(
	events: AsyncIterable<CompletionStreamEvent>,
	onText: (text: string) => void,
) {
	const { lifecycle } = await consumeCompletionStreamEvents(events, onText);
	return {
		emittedText: lifecycle.emittedText,
		streamErr: lifecycle.issue?.error || null,
		errMsg: lifecycle.issue?.message || "",
		completionTokens: tokenCountFromCounts(lifecycle.completionCounts),
		toolCalls: lifecycle.toolCalls,
		violation: lifecycle.violation,
	};
}
function consumePlainTextDeltas(
	deltas: AsyncIterable<string>,
	onText: (text: string) => void,
) {
	return consumeCompletionEvents(
		streamPlainCompletionEvents(streamProvider(deltas), {
			prompt: "test",
			rm: resolvedModel(),
			fileRefs: null,
		}),
		onText,
	);
}
function consumeToolSieveTextDeltas(
	deltas: AsyncIterable<string>,
	input: {
		tools?: unknown;
		toolPolicy?: ToolChoicePolicy | null;
	},
	onText: (text: string) => void,
) {
	return consumeCompletionEvents(
		streamToolSieveCompletionEvents(streamProvider(deltas), {
			prompt: "test",
			rm: resolvedModel(),
			fileRefs: null,
			...input,
		}),
		onText,
	);
}
describe("completion stream lifecycle", () => {
	test("reduces completion stream lifecycle events consistently", async () => {
		const failure = new Error("late failure");
		const toolCalls = [
			{
				name: "x",
				input: {},
			},
		];
		const lifecycleEvents: CompletionStreamEvent[] = [
			{ type: "text_delta", text: "partial" },
			{ type: "tool_calls", toolCalls },
			{ type: "warning", error: failure, message: "late failure" },
			{
				type: "done",
				emittedText: true,
				completionCounts: { asciiChars: 7, nonASCIIChars: 0, hasText: true },
			},
		];
		async function* events() {
			for (const event of lifecycleEvents) yield event;
		}
		const { lifecycle, outcome } = await consumeCompletionStreamEvents(
			events(),
		);
		assert.equal(lifecycle.emittedText, true);
		assert.equal(
			required(lifecycle.issue, "expected lifecycle issue").error,
			failure,
		);
		assert.deepEqual(lifecycle.toolCalls, toolCalls);
		assert.deepEqual(lifecycle.completionCounts, {
			asciiChars: 7,
			nonASCIIChars: 0,
			hasText: true,
		});
		assert.equal(outcome.type, "interrupted_after_output");
	});
	test("emits plain text deltas and token counts", async () => {
		const emitted: string[] = [];
		const result = await consumePlainTextDeltas(
			chunks(["hello", "", " world"]),
			(text) => emitted.push(text),
		);
		assert.deepEqual(emitted, ["hello", " world"]);
		assert.equal(result.emittedText, true);
		assert.equal(result.streamErr, null);
		assert.equal(result.completionTokens > 0, true);
	});
	test("preserves emitted deltas when stream later errors", async () => {
		const emitted: string[] = [];
		const result = await consumePlainTextDeltas(
			chunks(["partial"], 0),
			(text) => emitted.push(text),
		);
		assert.deepEqual(emitted, ["partial"]);
		assert.equal(result.emittedText, true);
		assert.equal(result.errMsg, "stream broke");
	});
	test("streams plain completion events while skipping empty deltas", async () => {
		const emptyTextObject = {
			toString() {
				return "";
			},
		};
		const events = await collectEvents(
			streamPlainCompletionEvents(
				streamProvider(chunks([null, emptyTextObject, "ok"])),
				{
					prompt: "plain prompt",
					rm: resolvedModel(),
					fileRefs: null,
				},
			),
		);
		assert.deepEqual(
			events.map((event) => event.type),
			["text_delta", "done"],
		);
		assert.equal(firstTextEvent(events).text, "ok");

		const plainAbort = new Error("plain abort");
		plainAbort.name = "AbortError";
		await assert.rejects(
			() =>
				collectEvents(
					streamPlainCompletionEvents(
						streamProvider(abortingAsyncIterable(plainAbort)),
						{
							prompt: "plain prompt",
							rm: resolvedModel(),
							fileRefs: null,
						},
					),
				),
			/plain abort/,
		);
	});
	test("preserves provider delta boundaries before reporting stream errors", async () => {
		async function* brokenDeltas() {
			yield "a";
			yield "b";
			throw new Error("coalesced stream broke");
		}
		const events = await collectEvents(
			streamPlainCompletionEvents(streamProvider(brokenDeltas()), {
				prompt: "plain prompt",
				rm: resolvedModel(),
				fileRefs: null,
			}),
		);
		assert.deepEqual(
			events
				.filter((event) => event.type === "text_delta")
				.map((event) => event.text),
			["a", "b"],
		);
		assert.equal(
			events.some((event) => event.type === "warning"),
			true,
		);
	});
	test("captures tool-sieve stream errors and preserves buffered visible text", async () => {
		async function* brokenToolDeltas() {
			yield "<tool_calls>";
			throw new Error("tool stream broke");
		}
		const emitted: string[] = [];
		const result = await consumeToolSieveTextDeltas(
			brokenToolDeltas(),
			{
				toolPolicy: null,
			},
			(text) => emitted.push(text),
		);
		assert.deepEqual(emitted, ["<tool_calls>"]);
		assert.equal(result.emittedText, true);
		assert.equal(errorMessage(result.streamErr), "tool stream broke");
		assert.equal(result.errMsg, "tool stream broke");

		const toolAbort: ErrorWithMetadata = new Error("tool abort");
		toolAbort.code = "request_aborted";
		await assert.rejects(
			() =>
				consumeToolSieveTextDeltas(
					abortingAsyncIterable(toolAbort),
					{ tools: null, toolPolicy: null },
					() => {},
				),
			/tool abort/,
		);
	});
	test("streams tool-sieve text deltas and buffered text boundaries", async () => {
		const longText = "x".repeat(100);
		const toolEvents = await collectEvents(
			streamToolSieveCompletionEvents(streamProvider(chunks([longText])), {
				prompt: "tool prompt",
				rm: resolvedModel(),
				fileRefs: null,
				toolPolicy: null,
			}),
		);
		assert.equal(
			toolEvents
				.filter((event) => event.type === "text_delta")
				.map((event) => event.text)
				.join(""),
			longText,
		);
		assert.equal(
			required(toolEvents.at(-1), "expected done event").type,
			"done",
		);

		const emptyEvents = await collectEvents(
			streamToolSieveCompletionEvents(streamProvider(chunks([])), {
				prompt: "empty buffered prompt",
				rm: resolvedModel(),
				fileRefs: null,
				toolPolicy: null,
			}),
		);
		assert.deepEqual(
			emptyEvents.map((event) => event.type),
			["done"],
		);
		const emptyDone = emptyEvents.at(-1);
		assert.equal(required(emptyDone, "expected done event").type, "done");
		assert.equal(
			(emptyDone as Extract<CompletionStreamEvent, { type: "done" }>)
				.emittedText,
			false,
		);

		const splitHeldCandidate = [
			'<tool_calls><invoke name="Read"><parameter name="path">',
			"README.md",
		];
		const splitEvents = await collectEvents(
			streamToolSieveCompletionEvents(
				streamProvider(chunks(splitHeldCandidate)),
				{
					prompt: "split buffered prompt",
					rm: resolvedModel(),
					fileRefs: null,
					toolPolicy: null,
				},
			),
		);
		// Incomplete tool markup is flushed as plain text at stream end.
		assert.equal(
			splitEvents
				.filter((event) => event.type === "text_delta")
				.map((event) => event.text)
				.join(""),
			splitHeldCandidate.join(""),
		);
		assert.equal(
			required(splitEvents.at(-1), "expected done event").type,
			"done",
		);
	});
	test("summarizes tool-sieve streams across success error and abort paths", async () => {
		const emitted: string[] = [];
		const longText = "y".repeat(100);
		const summary = await consumeToolSieveTextDeltas(
			chunks([longText]),
			{ toolPolicy: null },
			(text) => emitted.push(text),
		);
		assert.equal(summary.emittedText, true);
		assert.equal(summary.streamErr, null);
		assert.equal(emitted.join(""), longText);

		const errored: string[] = [];
		const errorSummary = await consumeToolSieveTextDeltas(
			chunks([longText], 0),
			{ toolPolicy: null },
			(text) => errored.push(text),
		);
		assert.equal(errorSummary.emittedText, true);
		assert.equal(errorSummary.errMsg, "stream broke");
		assert.equal(errorMessage(errorSummary.streamErr), "stream broke");
		assert.equal(errored.join(""), longText);

		const splitHeldCandidate = [
			'<tool_calls><invoke name="Read"><parameter name="path">',
			"README.md",
		];
		const splitEmitted: string[] = [];
		const splitSummary = await consumeToolSieveTextDeltas(
			chunks(splitHeldCandidate),
			{ toolPolicy: null },
			(text) => splitEmitted.push(text),
		);
		assert.equal(splitEmitted.join(""), splitHeldCandidate.join(""));
		assert.equal(splitSummary.emittedText, true);

		const bufferAbort = new Error("buffer abort");
		bufferAbort.name = "AbortError";
		await assert.rejects(
			() =>
				consumeToolSieveTextDeltas(
					abortingAsyncIterable(bufferAbort),
					{ toolPolicy: null },
					() => {},
				),
			/buffer abort/,
		);
	});
	test("sieves DSML tool calls out of streamed text", async () => {
		const emitted: string[] = [];
		const [prefix, suffix] = [
			'before <|DSML|tool_calls><|DSML|invoke name="Read"><|DSML|parameter name="file_path"><![CDATA[',
			"README.md]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>",
		];
		const result = await consumeToolSieveTextDeltas(
			chunks([prefix, suffix]),
			{
				tools: [
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				],
				toolPolicy: null,
			},
			(text) => emitted.push(text),
		);
		assert.deepEqual(emitted, ["before "]);
		assert.equal(Array.isArray(result.toolCalls), true);
		assert.equal(
			required(
				required(result.toolCalls, "expected tool calls")[0],
				"expected first tool call",
			).name,
			"Read",
		);
		assert.equal(result.violation, null);
	});
	test("reports required tool choice violation for plain output", async () => {
		const result = await consumeToolSieveTextDeltas(
			chunks(["plain answer"]),
			{
				tools: [
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				],
				toolPolicy: {
					mode: "required",
					forcedName: "",
					allowed: null,
					hasAllowed: false,
					declared: ["Read"],
					error: "",
				},
			},
			() => {},
		);
		assert.equal(result.toolCalls, null);
		assert.equal(
			required(result.violation, "expected policy violation").code,
			"tool_choice_violation",
		);
	});
});
