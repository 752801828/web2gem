/** Prompt assembly: history, messages, prompt text/build, attachment plans, Google parse. */
import {
	appendExistingFileRefs,
	createAttachmentPlan,
	mergeAttachmentPlans,
	normalizeUploadFileInput,
	recognizedFileRefID,
	type UploadFileInput,
	uploadFilenameFromObject,
} from "../attachments/plan";
import type { AttachmentFileRef, AttachmentPlan } from "../attachments/types";
import {
	asText,
	createPromptByteLengthSniffer,
	type PromptByteLengthBounded,
} from "../shared/text-metrics";
import { firstRecord, isRecord, type UnknownRecord } from "../shared/types";
import {
	formatPromptToolCallBlock,
	GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT,
	type ToolBundle,
} from "../toolcall/tool-bundle";
import {
	type InternalMessage,
	type InternalToolCall,
	type MessagePart,
	parseMessagePart,
	renderMessageBody,
} from "./message-model";
import type { PreparedTokenText, TokenCharCounts } from "./token-accounting";
import {
	addTokenCharCounts,
	buildTextWithTokens,
	createTokenCounter,
	tokenCharCounts,
	tokenCountFromCounts,
} from "./token-accounting";

// --- Prompt text accumulator ---

export type PromptMetadata = {
	hasToolPrompt: boolean;
	hasToolInstructions: boolean;
};

export type PromptBuildResult = {
	text: string;
	byteCheck: PromptByteLengthBounded | null;
	tokens: number;
	counts: TokenCharCounts & { hasText: boolean };
	latestInputText: string;
	hiddenPromptInsertOffset: number | null;
	metadata: PromptMetadata;
};

export type PromptAccumulatorResult = {
	text: string;
	byteCheck: PromptByteLengthBounded | null;
	tokens: number;
	counts: TokenCharCounts & { hasText: boolean };
};

export function createPromptPartAccumulator(maxBytes?: number | null): {
	add: (part: unknown) => void;
	length: () => number;
	text: () => string;
	result: () => PromptAccumulatorResult;
} {
	const parts: string[] = [];
	let textLength = 0;
	const sniffer =
		maxBytes == null ? null : createPromptByteLengthSniffer(maxBytes);
	const tokenCounter = createTokenCounter();
	return {
		add(part: unknown) {
			if (!part) return;
			const text = String(part);
			if (!text) return;
			if (parts.length) {
				if (sniffer) sniffer.append("\n\n");
				tokenCounter.append("\n\n");
				textLength += 2;
			}
			if (sniffer) sniffer.append(text);
			tokenCounter.append(text);
			textLength += text.length;
			parts.push(text);
		},
		length() {
			return textLength;
		},
		text() {
			return parts.join("\n\n");
		},
		result(): PromptAccumulatorResult {
			return {
				text: parts.join("\n\n"),
				byteCheck: sniffer ? sniffer.result() : null,
				tokens: tokenCounter.tokens(),
				counts: tokenCounter.counts(),
			};
		},
	};
}

// --- Prompt build helpers ---

type TokenCountsWithTextFlag = TokenCharCounts & { hasText: boolean };

export function structuredInstruction(requirement: unknown): string {
	if (!isRecord(requirement)) return "";
	return typeof requirement.instruction === "string"
		? requirement.instruction
		: "";
}

export function withGeminiNativeHiddenToolsPromptWithTokens(
	prompt: unknown,
	keepText = true,
	insertOffset?: number | null,
): PreparedTokenText {
	const text = String(prompt || "");
	const prepared = promptWithHiddenToolsPrompt(text, insertOffset);
	return buildTextWithTokens([prepared], keepText);
}

export function appendTextToPreparedWithTokens(
	prepared: PreparedTokenText,
	parts: readonly unknown[] | null | undefined,
	keepText = true,
): PreparedTokenText {
	const counts: TokenCountsWithTextFlag = {
		asciiChars: 0,
		nonASCIIChars: 0,
		hasText: false,
	};
	addTokenCharCounts(counts, prepared.counts);
	const out = keepText ? [prepared.text] : null;
	for (const part of parts || []) {
		const partText = asText(part);
		if (!partText) continue;
		const partCounts = tokenCharCounts(partText);
		addTokenCharCounts(counts, { ...partCounts, hasText: true });
		if (out) out.push(partText);
	}
	return {
		text: out ? out.join("") : "",
		tokens: tokenCountFromCounts(counts),
		counts,
	};
}

export function withGeminiNativeHiddenToolsPromptForPrepared(
	prepared: PreparedTokenText,
	keepText = true,
	insertOffset?: number | null,
): PreparedTokenText {
	if (!prepared.counts.hasText)
		return keepText ? prepared : { ...prepared, text: "" };
	if (keepText)
		return withGeminiNativeHiddenToolsPromptWithTokens(
			prepared.text,
			keepText,
			insertOffset,
		);
	return appendTextToPreparedWithTokens(
		prepared,
		["\n\n", GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT],
		false,
	);
}

function promptWithHiddenToolsPrompt(
	prompt: unknown,
	insertOffset?: number | null,
): string {
	const text = String(prompt || "");
	if (!text.trim()) return text;
	const offset = validInsertOffset(text, insertOffset);
	if (offset == null)
		return [GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT, text.trimEnd()].join("\n\n");
	const before = text.slice(0, offset).trimEnd();
	const after = text.slice(offset).trimStart();
	return [before, GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT, after]
		.filter(Boolean)
		.join("\n\n");
}

function validInsertOffset(text: string, insertOffset: unknown): number | null {
	if (typeof insertOffset !== "number" || !Number.isFinite(insertOffset))
		return null;
	const offset = Math.floor(insertOffset);
	if (offset <= 0 || offset >= text.length) return null;
	return offset;
}

function appendStructuredOutputInstructionWithTokens(
	prompt: unknown,
	requirement: unknown,
	keepText = true,
): PreparedTokenText {
	const instruction = structuredInstruction(requirement);
	if (!instruction) {
		const text = prompt || "";
		return buildTextWithTokens([text], keepText);
	}
	const base = String(prompt || "").trimEnd();
	const prepared = base
		? buildTextWithTokens([base, "\n\n", instruction], keepText)
		: buildTextWithTokens([instruction], keepText);
	return prepared;
}

export function appendStructuredOutputInstructionToPrepared(
	prepared: PreparedTokenText,
	requirement: unknown,
	keepText = true,
): PreparedTokenText {
	const instruction = structuredInstruction(requirement);
	if (!instruction) {
		return keepText ? prepared : { ...prepared, text: "" };
	}
	const countsSource = prepared.counts;
	const text = prepared.text;
	if (keepText && text.trimEnd() !== text) {
		return appendStructuredOutputInstructionWithTokens(
			prepared.text,
			requirement,
			keepText,
		);
	}
	const parts: string[] = [];
	const counts: TokenCountsWithTextFlag = {
		asciiChars: 0,
		nonASCIIChars: 0,
		hasText: false,
	};
	addTokenCharCounts(counts, countsSource);
	if (countsSource.hasText) {
		parts.push(text || "");
		const sepCounts = tokenCharCounts("\n\n");
		addTokenCharCounts(counts, { ...sepCounts, hasText: true });
		if (keepText) parts.push("\n\n");
	}
	const instructionCounts = tokenCharCounts(instruction);
	addTokenCharCounts(counts, { ...instructionCounts, hasText: !!instruction });
	if (keepText) parts.push(instruction);
	return {
		text: keepText ? parts.join("") : "",
		tokens: tokenCountFromCounts(counts),
		counts,
	};
}

// --- Messages to prompt ---

export type PromptToolContext = {
	bundle: ToolBundle;
	choiceInstruction: string;
	/** False when tool choice/mode is none: tools stay declared but unprompted. */
	include: boolean;
};

export function messagesToPrompt(
	messages: readonly InternalMessage[],
	toolContext: PromptToolContext | null,
	maxPromptBytes?: number | null,
): PromptBuildResult {
	const prompt = createPromptPartAccumulator(maxPromptBytes);
	let latestInputText = "";
	const includeTools = !!toolContext?.include;
	const promptToolDefs =
		includeTools && toolContext ? toolContext.bundle.promptArtifact.defs : [];

	if (promptToolDefs.length && toolContext) {
		prompt.add(
			toolContext.bundle.promptArtifact.inlinePromptBlock(
				toolContext.choiceInstruction,
			),
		);
	}
	const hiddenPromptInsertOffset = promptToolDefs.length
		? prompt.length()
		: null;

	for (const msg of messages) {
		const content = renderMessageBody(msg, "prompt");

		if (msg.role === "system") {
			prompt.add(`[System instruction]: ${content}`);
		} else if (msg.role === "assistant") {
			if (msg.toolCalls.length) {
				const tcStrs = msg.toolCalls.map((tc) =>
					formatPromptToolCallBlock(tc.name, tc.args),
				);
				prompt.add(`[Assistant]: ${content || ""}\n${tcStrs.join("\n")}`);
			} else {
				prompt.add(`[Assistant]: ${content}`);
			}
		} else if (msg.role === "tool") {
			const meta: string[] = [];
			if (msg.toolName) meta.push(msg.toolName);
			if (msg.toolCallId) meta.push(`id=${msg.toolCallId}`);
			prompt.add(
				`[Tool result${meta.length ? ` for ${meta.join(" ")}` : ""}]: ${content || "null"}`,
			);
		} else {
			const latest = renderMessageBody(msg, "latest-input").trim();
			if (msg.roleLabel === "user" && latest) latestInputText = latest;
			prompt.add(content ? content : "");
		}
	}

	const accumulated = prompt.result();
	const hasToolPrompt = promptToolDefs.length > 0;
	return {
		text: accumulated.text,
		byteCheck: accumulated.byteCheck,
		tokens: accumulated.tokens,
		counts: accumulated.counts,
		latestInputText,
		hiddenPromptInsertOffset,
		metadata: {
			hasToolPrompt,
			hasToolInstructions: hasToolPrompt,
		},
	};
}

// --- History transcript ---

type HistoryTranscriptEntry = {
	role: string;
	content: string;
};

export function buildOpenAIHistoryTranscript(
	messages: readonly InternalMessage[],
	filename: unknown = "message.txt",
): string {
	const entries: HistoryTranscriptEntry[] = [];
	for (const msg of messages) {
		let content = "";
		if (msg.role === "assistant") {
			content = renderMessageBody(msg, "history");
			if (msg.toolCalls.length) {
				const blocks = msg.toolCalls.map((tc) =>
					formatPromptToolCallBlock(tc.name, tc.args),
				);
				content = [content, ...blocks].filter(Boolean).join("\n");
			}
		} else if (msg.role === "tool") {
			const meta: string[] = [];
			if (msg.toolName) meta.push(`name=${msg.toolName}`);
			if (msg.toolCallId) meta.push(`tool_call_id=${msg.toolCallId}`);
			const toolContent = renderMessageBody(msg, "history").trim() || "null";
			content = [meta.length ? `[${meta.join(" ")}]` : "", toolContent]
				.filter(Boolean)
				.join("\n");
		} else {
			content = renderMessageBody(msg, "history");
		}
		content = String(content || "").trim();
		if (content) entries.push({ role: msg.roleLabel, content });
	}
	if (!entries.length) return "";
	const sections = entries.map(
		(entry, idx) =>
			`=== ${idx + 1}. ${entry.role.toUpperCase()} ===\n${entry.content}`,
	);
	return `# ${filename || "message.txt"}\nPrior conversation history and tool progress.\n\n${sections.join("\n\n")}\n`;
}

// --- Attachment inputs ---

type MessageImageInput = { b64: string; mime: string; filename: string };
type MessageAttachmentInputs = {
	images: MessageImageInput[];
	files: UploadFileInput[];
};
type RequestAttachmentInputs = MessageAttachmentInputs & {
	existingFileRefs: AttachmentFileRef[];
};

const REFERENCE_NESTED_KEYS = [
	"attachments",
	"files",
	"items",
	"content",
	"data",
	"source",
	"file",
] as const;
const ATTACHMENT_NESTED_KEYS = [...REFERENCE_NESTED_KEYS, "image_url"] as const;

function attachmentInputsFromMessages(
	messages: readonly InternalMessage[],
): MessageAttachmentInputs {
	const images: MessageImageInput[] = [];
	const files: UploadFileInput[] = [];
	for (const message of messages) {
		for (const part of message.parts) {
			if (part.kind === "image" && part.hasInline)
				images.push({
					b64: part.b64,
					mime: part.mime,
					filename: part.filename,
				});
			else if (part.kind === "file" && part.upload) files.push(part.upload);
		}
	}
	return { images, files };
}

export function openAIAttachmentPlanFromRequest(
	req: unknown,
	messages: readonly InternalMessage[],
): AttachmentPlan {
	const messageInputs = attachmentInputsFromMessages(messages);
	const requestInputs = requestAttachmentInputs(req, false);
	return mergeAttachmentPlans(
		createAttachmentPlan(requestInputs),
		createAttachmentPlan({
			images: messageInputs.images,
			files: messageInputs.files,
			existingFileRefs: attachmentRefsFromMessages(messages),
		}),
		createAttachmentPlan({
			existingFileRefs: requestRefsFromChannel(req, "input"),
		}),
	);
}

function attachmentRefsFromMessages(
	messages: readonly InternalMessage[],
): AttachmentFileRef[] {
	const refs: AttachmentFileRef[] = [];
	for (const message of messages) {
		for (const part of message.parts) {
			if (part.kind !== "image" && part.kind !== "file") continue;
			if (part.fileRef) appendExistingFileRefs(refs, part.fileRef);
		}
	}
	return refs;
}

function requestAttachmentInputs(
	req: unknown,
	includeInputRefs = true,
): RequestAttachmentInputs {
	const out: RequestAttachmentInputs = {
		images: [],
		files: [],
		existingFileRefs: [],
	};
	if (!isRecord(req)) return out;
	appendRequestRefs(out.existingFileRefs, req.ref_file_ids);
	appendRequestRefs(out.existingFileRefs, req.file_ids);
	for (const key of ["attachments", "files"] as const)
		appendRequestAttachmentInputs(out, req[key]);
	if (includeInputRefs) appendRequestRefs(out.existingFileRefs, req.input);
	return out;
}

function requestRefsFromChannel(
	req: unknown,
	key: string,
): AttachmentFileRef[] {
	const refs: AttachmentFileRef[] = [];
	if (isRecord(req)) appendRequestRefs(refs, req[key]);
	return refs;
}

function appendRequestAttachmentInputs(
	out: RequestAttachmentInputs,
	raw: unknown,
): void {
	if (raw == null) return;
	if (Array.isArray(raw))
		for (const item of raw) appendRequestAttachmentInputs(out, item);
	if (!isRecord(raw)) return;
	const part = parseMessagePart(raw);
	if (part?.kind === "image" || part?.kind === "file") {
		if (part.kind === "image" && part.hasInline)
			out.images.push({
				b64: part.b64,
				mime: part.mime,
				filename: part.filename,
			});
		else if (part.kind === "file" && part.upload) out.files.push(part.upload);
		if (part.fileRef)
			appendExistingFileRefs(out.existingFileRefs, part.fileRef);
		return;
	}
	const upload = normalizeUploadFileInput(raw);
	if (upload) {
		out.files.push(upload);
		return;
	}
	const directID = recognizedFileRefID(raw, true);
	if (directID) {
		const name = uploadFilenameFromObject(raw);
		appendExistingFileRefs(
			out.existingFileRefs,
			name ? { id: String(directID), name } : String(directID),
		);
		return;
	}
	for (const key of ATTACHMENT_NESTED_KEYS) {
		if (key in raw) appendRequestAttachmentInputs(out, raw[key]);
	}
}

function appendRequestRefs(out: AttachmentFileRef[], raw: unknown): void {
	if (raw == null) return;
	if (Array.isArray(raw)) for (const item of raw) appendRequestRefs(out, item);
	if (typeof raw === "string") appendExistingFileRefs(out, raw);
	if (!isRecord(raw)) return;
	const part = parseMessagePart(raw);
	if (part?.kind === "image" || part?.kind === "file") {
		if (part.fileRef) appendExistingFileRefs(out, part.fileRef);
		return;
	}
	const id = recognizedFileRefID(raw, true);
	if (id) appendExistingFileRefs(out, id);
	else
		for (const key of REFERENCE_NESTED_KEYS) {
			if (key in raw) appendRequestRefs(out, raw[key]);
		}
}

export function attachmentPlanFromMessages(
	messages: readonly InternalMessage[],
): AttachmentPlan {
	const { images, files } = attachmentInputsFromMessages(messages);
	return createAttachmentPlan({ images, files });
}

// --- Google request parse ---

/**
 * Parse a Google `generateContent` request (contents/parts + systemInstruction)
 * into the shared internal message model. Each Google-wire part is dispatched
 * through the single content-part walker (`parseMessagePart`) via an intermediate
 * OpenAI-shaped part record, so there is one part parser for both dialects.
 */
export function parseGoogleRequest(req: unknown): InternalMessage[] {
	const request = isRecord(req) ? req : {};
	const messages: InternalMessage[] = [];

	const sysInst = isRecord(request.systemInstruction)
		? request.systemInstruction
		: null;
	if (sysInst && Array.isArray(sysInst.parts)) {
		const sysText = sysInst.parts
			.filter((part) => isRecord(part) && part.text)
			.map((part) => (isRecord(part) ? part.text : ""))
			.join(" ");
		if (sysText)
			messages.push(makeMessage("system", parseParts([{ text: sysText }])));
	}

	const contents = Array.isArray(request.contents) ? request.contents : [];
	for (const content of contents) {
		if (!isRecord(content)) continue;
		const role = content.role === "model" ? "assistant" : "user";
		let pending: unknown[] = [];
		const toolCalls: InternalToolCall[] = [];
		const parts = Array.isArray(content.parts) ? content.parts : [];

		const flushContent = () => {
			if (!pending.length && !toolCalls.length) return;
			messages.push(
				makeMessage(role, parseParts(pending), toolCalls.splice(0)),
			);
			pending = [];
		};

		for (const p of parts) {
			if (!isRecord(p)) continue;
			if (p.text) {
				pending.push({ type: "text", text: p.text });
			} else if (p.inlineData || p.inline_data) {
				const inlineData = firstRecord(p.inlineData, p.inline_data) || {};
				const mime = inlineData.mimeType || inlineData.mime_type || "image/png";
				const isImage = String(mime || "")
					.trim()
					.toLowerCase()
					.startsWith("image/");
				pending.push({
					type: isImage ? "image" : "file",
					source: { data: inlineData.data, media_type: mime },
					filename: uploadNameFromPart(p),
				});
			} else if (p.fileData || p.file_data) {
				const fileData = firstRecord(p.fileData, p.file_data) || {};
				pending.push({
					type: "file",
					fileData,
					filename: uploadNameFromPart(p),
				});
			} else if (isRecord(p.functionCall)) {
				const fc = p.functionCall;
				toolCalls.push({
					id: "",
					name: String(fc.name || ""),
					args: isRecord(fc.args) ? fc.args : {},
				});
			} else if (isRecord(p.functionResponse)) {
				const fr = p.functionResponse;
				flushContent();
				messages.push({
					role: "tool",
					roleLabel: "tool",
					parts: parseParts([
						{ type: "text", text: JSON.stringify(fr.response || {}) },
					]),
					toolCalls: [],
					toolCallId: "",
					toolName: fr.name ? String(fr.name) : "",
					reasoningText: "",
				});
			}
		}

		flushContent();
	}

	return messages;
}

function makeMessage(
	role: "system" | "user" | "assistant",
	parts: MessagePart[],
	toolCalls: InternalToolCall[] = [],
): InternalMessage {
	return {
		role,
		roleLabel: role,
		parts,
		toolCalls,
		toolCallId: "",
		toolName: "",
		reasoningText: "",
	};
}

function parseParts(rawParts: readonly unknown[]): MessagePart[] {
	const out: MessagePart[] = [];
	for (const raw of rawParts) {
		const part = parseMessagePart(raw, "item");
		if (part) out.push(part);
	}
	return out;
}

function uploadNameFromPart(part: UnknownRecord): string {
	return uploadFilenameFromObject(part);
}
