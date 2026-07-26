import type { UploadFileInput } from "../attachments/input";
import type { AttachmentFileRef } from "../attachments/types";
import type { UnknownRecord } from "../shared/types";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type TextPart = {
	kind: "text";
	text: string;
	/**
	 * True when the text came from direct input text (string parts and
	 * text/input_text-typed parts); false for assistant output/summary echoes
	 * and unknown-typed text fallbacks, which prompt rendering includes but
	 * user-input extraction (image generation) must skip.
	 */
	inputText: boolean;
};

export type ReasoningPart = {
	kind: "reasoning";
	text: string;
};

export type ImagePart = {
	kind: "image";
	b64: string;
	mime: string;
	filename: string;
	remoteUrl: string;
	fileRef: AttachmentFileRef | null;
	hasInline: boolean;
};

export type FilePart = {
	kind: "file";
	upload: UploadFileInput | null;
	filename: string;
	remoteUrl: string;
	fileRef: AttachmentFileRef | null;
	label: string;
};

export type MessagePart = TextPart | ReasoningPart | ImagePart | FilePart;

export type InternalToolCall = {
	id: string;
	name: string;
	args: UnknownRecord;
};

export type InternalMessage = {
	role: MessageRole;
	roleLabel: string;
	parts: MessagePart[];
	toolCalls: InternalToolCall[];
	toolCallId: string;
	toolName: string;
	reasoningText: string;
};

export type MessageProjectionMode =
	| "prompt"
	| "history"
	| "latest-input"
	| "reasoning";

export function createInternalMessage(
	roleValue: unknown,
	parts: MessagePart[],
	options: {
		toolCalls?: InternalToolCall[];
		toolCallId?: unknown;
		toolName?: unknown;
		reasoningText?: unknown;
	} = {},
): InternalMessage {
	const roleLabel = normalizeMessageRole(roleValue);
	return {
		role: messageRoleBucket(roleLabel),
		roleLabel,
		parts,
		toolCalls: options.toolCalls || [],
		toolCallId: options.toolCallId == null ? "" : String(options.toolCallId),
		toolName: options.toolName == null ? "" : String(options.toolName),
		reasoningText:
			typeof options.reasoningText === "string"
				? options.reasoningText.trim()
				: "",
	};
}

/**
 * Role normalization for message/history records: `function` -> `tool`,
 * `developer` -> `system`, default `user`.
 */
export function normalizeMessageRole(role: unknown): string {
	const r = String(role || "")
		.trim()
		.toLowerCase();
	if (r === "function") return "tool";
	if (r === "developer") return "system";
	return r || "user";
}

/** Whether an item/part type flattens to text (text|input_text|output_text|summary_text). */
export function isTextPartType(type: unknown): boolean {
	const t = String(type || "")
		.trim()
		.toLowerCase();
	return (
		t === "text" ||
		t === "input_text" ||
		t === "output_text" ||
		t === "summary_text"
	);
}

function messageRoleBucket(roleLabel: string): MessageRole {
	if (
		roleLabel === "system" ||
		roleLabel === "assistant" ||
		roleLabel === "tool"
	)
		return roleLabel;
	return "user";
}
