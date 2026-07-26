import { isRecord, type UnknownRecord } from "../shared/types";
import {
	flattenText,
	parseMessageContent,
	parseOpenAIMessages,
	parseToolCallArguments,
} from "./message-parse";
import { projectMessageText } from "./message-project";
import {
	createInternalMessage,
	type InternalMessage,
	type InternalToolCall,
} from "./message-types";
import {
	isResponsesFileInputType,
	reduceResponsesSequence,
	rememberResponsesCallName,
	responsesCallName,
	responsesInputItemType,
	responsesItemKind,
	responsesItemRole,
	responsesReasoningText,
	type ResponsesSequenceEvent,
	responsesToolCallInput,
	responsesToolResultCallID,
} from "./responses-semantics";

export type ResponsesInputMode = "completion" | "image-generation";

export type ResponsesInputParseResult =
	| { messages: InternalMessage[]; error?: undefined }
	| { messages?: undefined; error: string };

type DirectItemResult =
	| { kind: "message"; message: InternalMessage }
	| { kind: "reasoning"; text: string }
	| { kind: "unknown" }
	| { kind: "error"; error: string };

export function parseResponsesInput(
	req: unknown,
	mode: ResponsesInputMode = "completion",
): ResponsesInputParseResult {
	if (!isRecord(req)) return { error: "request body must be a JSON object" };
	let parsed: ResponsesInputParseResult;
	if (Array.isArray(req.messages) && req.messages.length) {
		parsed = { messages: parseOpenAIMessages(req.messages) };
	} else {
		parsed = parseResponsesInputValue(req.input, mode);
	}
	if (parsed.error || !parsed.messages) return parsed;
	const instructions =
		typeof req.instructions === "string" ? req.instructions.trim() : "";
	if (!instructions) return parsed;
	return {
		messages: [
			createInternalMessage("system", parseMessageContent(instructions)),
			...parsed.messages,
		],
	};
}

function parseResponsesInputValue(
	input: unknown,
	mode: ResponsesInputMode,
): ResponsesInputParseResult {
	if (input == null) return { messages: [] };
	if (typeof input === "string") {
		return {
			messages: input.trim()
				? [createInternalMessage("user", parseMessageContent(input))]
				: [],
		};
	}
	if (Array.isArray(input)) return parseResponsesInputArrayDirect(input, mode);
	if (!isRecord(input)) {
		return {
			error:
				"Responses input must be a string, object, or array of supported items",
		};
	}
	const callNameByID: Record<string, string> = {};
	const item = parseResponsesInputItemDirect(input, callNameByID, mode);
	if (item.kind === "error") return { error: `input ${item.error}` };
	if (item.kind === "unknown") return { messages: [] };
	if (item.kind === "reasoning") {
		return {
			messages: [
				createInternalMessage("assistant", [], {
					reasoningText: item.text,
				}),
			],
		};
	}
	return { messages: [item.message] };
}

function parseResponsesInputArrayDirect(
	items: readonly unknown[],
	mode: ResponsesInputMode,
): ResponsesInputParseResult {
	const callNameByID: Record<string, string> = {};
	const events: ResponsesSequenceEvent<InternalMessage>[] = [];
	for (let index = 0; index < items.length; index++) {
		const raw = items[index];
		if (typeof raw === "string") {
			if (!raw.trim())
				return { error: `Responses input item ${index} is empty` };
			events.push({ kind: "fallback", text: raw });
			continue;
		}
		if (!isRecord(raw)) {
			return {
				error: `Responses input item ${index} must be a supported object or string`,
			};
		}

		const item = parseResponsesInputItemDirect(raw, callNameByID, mode);
		if (item.kind === "error")
			return { error: `Responses input item ${index} ${item.error}` };
		if (item.kind === "unknown") continue;
		if (item.kind === "reasoning") {
			events.push({ kind: "reasoning", text: item.text });
			continue;
		}
		events.push({ kind: "message", value: item.message });
	}
	return {
		messages: reduceResponsesSequence(events, {
			createReasoning: (text) =>
				createInternalMessage("assistant", [], { reasoningText: text }),
			createFallback: (text) =>
				createInternalMessage("user", parseMessageContent(text)),
			isToolCall: isInternalAssistantToolCallMessage,
			reasoningText: (message) => projectMessageText(message, "reasoning"),
			attachReasoning: (message, text) => {
				message.reasoningText = text;
			},
			mergeToolCalls: (previous, next) => {
				previous.toolCalls.push(...next.toolCalls);
				if (!projectMessageText(previous, "reasoning"))
					previous.reasoningText = projectMessageText(next, "reasoning");
				return true;
			},
		}),
	};
}

function parseResponsesInputItemDirect(
	item: UnknownRecord,
	callNameByID: Record<string, string>,
	mode: ResponsesInputMode,
): DirectItemResult {
	const type = responsesInputItemType(item);
	const kind = responsesItemKind(item);
	if (type === "input_image" && mode === "completion")
		return directError("has unsupported type: input_image");
	if (kind === "role-message") return parseResponsesRoleMessage(item, type);
	if (kind === "message") return parseResponsesRoleMessage(item, type, "user");

	if (kind === "tool-result") {
		if (item.output == null && item.content == null)
			return directError("tool result requires output");
		const callID = responsesToolResultCallID(item);
		return directMessage(
			createInternalMessage(
				"tool",
				parseMessageContent(item.output ?? item.content),
				{
					toolCallId: callID,
					toolName:
						item.name ||
						item.tool_name ||
						responsesCallName(callNameByID, callID) ||
						"",
				},
			),
		);
	}

	if (kind === "tool-call") {
		const call = responsesToolCall(item);
		if (!call) return directError("function call requires name");
		rememberResponsesCallName(callNameByID, call);
		return directMessage(
			createInternalMessage("assistant", [], { toolCalls: [call] }),
		);
	}

	if (kind === "reasoning") {
		const text = responsesReasoningText(item);
		return text
			? { kind: "reasoning", text }
			: directError("reasoning item requires text");
	}

	if (kind === "input-image") {
		return directMessage(
			createInternalMessage("user", parseMessageContent([item])),
		);
	}
	if (kind === "file") {
		return directMessage(
			createInternalMessage("user", parseMessageContent([item])),
		);
	}
	if (kind === "text") {
		if (typeof item.text !== "string" || !item.text.trim())
			return directError("text item requires text");
		return directMessage(
			createInternalMessage("user", parseMessageContent([item])),
		);
	}
	return { kind: "unknown" };
}

function parseResponsesRoleMessage(
	item: UnknownRecord,
	itemType: string,
	defaultRole?: string,
): DirectItemResult {
	const role = responsesItemRole(item, defaultRole ?? "user");
	if (role === "assistant") return parseResponsesAssistantDirect(item);
	let content = item.content ?? (role === "tool" ? item.output : null);
	if (
		content == null &&
		((typeof item.text === "string" && item.text.trim()) ||
			typeof item.text === "number" ||
			typeof item.text === "boolean")
	)
		content = item.text;
	if (
		content == null &&
		(isResponsesFileInputType(itemType) || itemType === "input_image")
	)
		content = [item];
	if (content == null)
		return directError(
			role === "tool"
				? "tool message requires content"
				: "message requires content",
		);
	return directMessage(
		createInternalMessage(role, parseMessageContent(content), {
			toolCallId: role === "tool" ? (item.tool_call_id ?? item.call_id) : "",
			toolName: role === "tool" ? item.name : "",
		}),
	);
}

function parseResponsesAssistantDirect(item: UnknownRecord): DirectItemResult {
	const content =
		item.content ?? (typeof item.text === "string" ? item.text : null);
	const parts = parseMessageContent(content);
	const toolCalls = [
		...responsesToolCalls(item.tool_calls),
		...responsesContentToolCalls(content),
	];
	const reasoningText = flattenText(
		item.reasoning_content ?? item.reasoning ?? item.thinking,
	);
	const message = createInternalMessage("assistant", parts, {
		toolCalls,
		reasoningText,
	});
	const reasoningOnly = projectMessageText(message, "reasoning");
	const hasVisiblePart = parts.some(
		(part) =>
			part.kind !== "reasoning" && (part.kind !== "text" || !!part.text),
	);
	if (!toolCalls.length && !hasVisiblePart && reasoningOnly)
		return { kind: "reasoning", text: reasoningOnly };
	if (!toolCalls.length && !parts.length && !reasoningText)
		return directError("assistant message requires content or tool calls");
	return directMessage(message);
}

function responsesToolCalls(raw: unknown): InternalToolCall[] {
	if (!Array.isArray(raw)) return [];
	const calls: InternalToolCall[] = [];
	for (let index = 0; index < raw.length; index++) {
		const record = isRecord(raw[index]) ? raw[index] : null;
		if (!record) continue;
		const fn = isRecord(record.function) ? record.function : {};
		calls.push({
			id: String(record.id ?? record.call_id ?? ""),
			name: String(fn.name ?? record.name ?? ""),
			args: parseToolCallArguments(
				fn.arguments ?? fn.input ?? record.arguments ?? record.input,
			),
		});
	}
	return calls;
}

function responsesContentToolCalls(content: unknown): InternalToolCall[] {
	const rawParts = Array.isArray(content) ? content : [];
	const calls: InternalToolCall[] = [];
	for (const raw of rawParts) {
		if (!isRecord(raw)) continue;
		const type = responsesInputItemType(raw);
		if (type !== "function_call" && type !== "tool_call") continue;
		const call = responsesToolCall(raw);
		if (call) calls.push(call);
	}
	return calls;
}

function responsesToolCall(item: UnknownRecord): InternalToolCall | null {
	const call = responsesToolCallInput(item);
	if (!call) return null;
	return {
		id: call.id,
		name: call.name,
		args: parseToolCallArguments(call.arguments),
	};
}

function isInternalAssistantToolCallMessage(message: InternalMessage): boolean {
	return message.role === "assistant" && message.toolCalls.length > 0;
}

function directMessage(message: InternalMessage): DirectItemResult {
	return { kind: "message", message };
}

function directError(error: string): DirectItemResult {
	return { kind: "error", error };
}
