import type {
	InternalMessage,
	MessagePart,
	MessageProjectionMode,
} from "./message-types";

function projectMessageParts(
	message: InternalMessage,
	mode: Exclude<MessageProjectionMode, "reasoning">,
): string {
	const parts: string[] = [];
	for (const part of message.parts) {
		const text = projectMessagePart(part, mode);
		if (text) parts.push(text);
	}
	return parts.join("\n");
}

export function projectMessageText(
	message: InternalMessage,
	mode: MessageProjectionMode,
): string {
	if (mode !== "reasoning") return projectMessageParts(message, mode);
	const parts: string[] = [];
	for (const part of message.parts) {
		if (part.kind === "reasoning" && part.text) parts.push(part.text);
	}
	const embedded = parts.join("\n").trim();
	return embedded || message.reasoningText.trim();
}

export function renderMessageBody(
	message: InternalMessage,
	mode: Exclude<MessageProjectionMode, "reasoning">,
): string {
	const content = projectMessageParts(message, mode);
	if (message.role !== "assistant") return content;
	const hasEmbeddedReasoning = message.parts.some(
		(part) => part.kind === "reasoning" && !!part.text,
	);
	const reasoning =
		hasEmbeddedReasoning || content.includes("[reasoning_content]")
			? ""
			: message.reasoningText.trim();
	if (!reasoning) return content;
	return [reasoningBlock(reasoning), content].filter(Boolean).join("\n\n");
}

export function latestUserInputText(
	messages: readonly InternalMessage[],
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.roleLabel !== "user") continue;
		const text = renderMessageBody(message, "latest-input").trim();
		if (text) return text;
	}
	return "";
}

function projectMessagePart(
	part: MessagePart,
	_mode: Exclude<MessageProjectionMode, "reasoning">,
): string {
	if (part.kind === "text") return part.text;
	if (part.kind === "reasoning")
		return part.text ? reasoningBlock(part.text) : "";
	if (part.kind === "image") return "[image input]";
	return `[file input${part.label ? ` ${part.label}` : ""}]`;
}

function reasoningBlock(text: string): string {
	return `[reasoning_content]\n${text}\n[/reasoning_content]`;
}
