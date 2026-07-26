import { describe, test } from "vitest";
import {
	parseResponsesInput,
	type ResponsesInputParseResult,
} from "../../../src/promptcompat/responses";
import type {
	ImagePart,
	InternalMessage,
	InternalToolCall,
	MessagePart,
} from "../../../src/promptcompat/message-model";
import { assert } from "../assertions.js";

function parsedMessages(result: ResponsesInputParseResult): InternalMessage[] {
	if (result.error !== undefined) throw new Error(result.error);
	return result.messages;
}

function itemAt<T>(items: readonly T[], index: number, label: string): T {
	const item = items[index];
	if (item === undefined) throw new Error(`${label} ${index} is required`);
	return item;
}

function messageAt(messages: readonly InternalMessage[], index: number) {
	return itemAt(messages, index, "message");
}

function partAt(message: InternalMessage, index: number): MessagePart {
	return itemAt(message.parts, index, "message part");
}

function textPartAt(message: InternalMessage, index: number) {
	const part = partAt(message, index);
	if (part.kind !== "text" && part.kind !== "reasoning") {
		throw new Error(`message part ${index} must contain text`);
	}
	return part;
}

function imagePartAt(message: InternalMessage, index: number): ImagePart {
	const part = partAt(message, index);
	if (part.kind !== "image")
		throw new Error(`message part ${index} must be image`);
	return part;
}

function toolCallAt(message: InternalMessage, index: number): InternalToolCall {
	return itemAt(message.toolCalls, index, "tool call");
}

describe("prompt compatibility", () => {
	test("parses Responses items directly into typed messages in order", async () => {
		const objectArgs = { id: 7 };
		const result = parseResponsesInput({
			instructions: "be brief",
			input: [
				{ type: "reasoning", text: "first thought" },
				{
					type: "thinking",
					content: [{ type: "summary_text", text: "second thought" }],
				},
				{
					type: "function_call",
					call_id: "call_1",
					name: "Lookup",
					arguments: objectArgs,
				},
				{
					type: "function_call",
					call_id: "call_2",
					function: { name: "Read", arguments: '{"path":"README.md"}' },
				},
				{
					type: "function_call_output",
					call_id: "call_1",
					output: { ok: true },
				},
				"follow",
				"up",
			],
		});

		assert.equal(result.error, undefined);
		const messages = parsedMessages(result);
		const system = messageAt(messages, 0);
		const assistant = messageAt(messages, 1);
		const tool = messageAt(messages, 2);
		const followUp = messageAt(messages, 3);
		assert.equal(system.role, "system");
		assert.equal(textPartAt(system, 0).text, "be brief");
		assert.equal(assistant.role, "assistant");
		assert.equal(assistant.reasoningText, "first thought\nsecond thought");
		assert.equal(assistant.toolCalls.length, 2);
		assert.equal(toolCallAt(assistant, 0).args, objectArgs);
		assert.deepEqual(toolCallAt(assistant, 1).args, {
			path: "README.md",
		});
		assert.deepEqual(
			{
				role: tool.role,
				toolCallId: tool.toolCallId,
				toolName: tool.toolName,
				text: textPartAt(tool, 0).text,
			},
			{
				role: "tool",
				toolCallId: "call_1",
				toolName: "Lookup",
				text: '{"ok":true}',
			},
		);
		assert.equal(textPartAt(followUp, 0).text, "follow\nup");
	});

	test("uses explicit Responses modes and ignores unknown top-level items", async () => {
		const imageInput = {
			type: "input_image",
			image_url: "data:image/png;base64,QUJD",
		};
		assert.match(
			parseResponsesInput({ input: [imageInput] }, "completion").error,
			/unsupported type: input_image/,
		);
		const image = parseResponsesInput(
			{ input: [imageInput] },
			"image-generation",
		);
		const imageMessage = messageAt(parsedMessages(image), 0);
		assert.equal(imagePartAt(imageMessage, 0).kind, "image");
		assert.equal(imagePartAt(imageMessage, 0).b64, "QUJD");

		const mixed = parseResponsesInput({
			input: [
				{ type: "custom_event", text: "hidden" },
				{ type: "input_text", text: "visible" },
			],
		});
		const mixedMessages = parsedMessages(mixed);
		assert.equal(mixedMessages.length, 1);
		assert.equal(textPartAt(messageAt(mixedMessages, 0), 0).text, "visible");
		assert.deepEqual(
			parseResponsesInput({ input: { type: "custom_event", text: "hidden" } }),
			{ messages: [] },
		);
		assert.deepEqual(parseResponsesInput({ input: null }), { messages: [] });
		assert.deepEqual(parseResponsesInput({ input: "   " }), { messages: [] });
		assert.match(parseResponsesInput({ input: true }).error, /string, object/);
	});

	test("preserves typed role messages and rejects malformed recognized items", async () => {
		const assistant = parseResponsesInput({
			input: {
				role: "assistant",
				content: [
					{ type: "reasoning", summary: "checked" },
					{ type: "output_text", text: "visible" },
					{ type: "function_call", name: "Search", input: { q: "docs" } },
				],
				tool_calls: [
					null,
					{
						id: "call_existing",
						function: { name: "Existing", arguments: "{}" },
					},
				],
			},
		});
		const assistantMessage = messageAt(parsedMessages(assistant), 0);
		assert.equal(partAt(assistantMessage, 0).kind, "reasoning");
		assert.equal(textPartAt(assistantMessage, 1).text, "visible");
		assert.deepEqual(
			assistantMessage.toolCalls.map((call) => call.name),
			["Existing", "Search"],
		);

		const reasoning = parseResponsesInput({
			input: {
				role: "assistant",
				content: [{ type: "reasoning", text: "only" }],
			},
		});
		assert.equal(messageAt(parsedMessages(reasoning), 0).reasoningText, "only");
		const tool = parseResponsesInput({
			input: { role: "tool", call_id: "call_9", name: "Lookup", output: 0 },
		});
		const toolMessage = messageAt(parsedMessages(tool), 0);
		assert.equal(textPartAt(toolMessage, 0).text, "0");
		assert.equal(toolMessage.toolCallId, "call_9");

		const invalidInputs: readonly (readonly [unknown, RegExp])[] = [
			[[""], /item 0 is empty/],
			[[42], /item 0 must be a supported object or string/],
			[[{ type: "tool_result" }], /tool result requires output/],
			[[{ type: "function_call" }], /function call requires name/],
			[[{ type: "reasoning" }], /reasoning item requires text/],
			[[{ type: "input_text", text: "" }], /text item requires text/],
			[{ role: "user" }, /message requires content/],
			[
				{ role: "assistant" },
				/assistant message requires content or tool calls/,
			],
		];
		for (const [input, pattern] of invalidInputs) {
			const invalid = parseResponsesInput({ input });
			assert.match(invalid.error, pattern);
		}
	});
});
