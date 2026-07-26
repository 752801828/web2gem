/** Prompt assembly: history, messages, and prompt text/build helpers. */
import {
	asText,
	createPromptByteLengthSniffer,
	type PromptByteLengthBounded,
} from "../shared/text-metrics";
import { isRecord } from "../shared/types";
import {
	formatPromptToolCallBlock,
	GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT,
	type ToolBundle,
} from "../toolcall/tool-bundle";
import { type InternalMessage, renderMessageBody } from "./message-model";
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
