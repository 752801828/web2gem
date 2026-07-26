import type { RuntimeConfig } from "../config";
import type { ResolvedModelOk } from "../models";
import type { InternalMessage } from "../promptcompat/message-model";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
	upstreamErrorStatus,
} from "../shared/errors";
import { log } from "../shared/logging";
import {
	googleToolChoiceInstructionFromPolicy,
	parseGoogleToolChoicePolicy,
} from "../toolcall/policy";
import type { ToolChoicePolicy } from "../toolcall/policy";
import {
	buildToolChoiceInstructionFromPolicy,
	parseOpenAIToolChoicePolicy,
} from "../toolcall/policy";
import {
	createToolBundle,
	filterToolBundleByPolicy,
	type ToolBundle,
	toolCallInstructionsFor,
	toolNamesForPromptSource,
	toolPromptBlockFor,
} from "../toolcall/tool-bundle";
import {
	prepareGoogleGeminiContext,
	prepareOpenAIGeminiContext,
} from "./context";
import type { CompletionProvider } from "./ports";
import {
	buildStructuredOutputRequirement,
	getStructuredResponseFormat,
} from "./structured-output";
import type { UnknownRecord } from "../shared/types";
import type {
	ContextFileResult,
	FileRef,
	GeminiContextPrepareResult,
	PromptMetadata,
} from "./types";
import { hasCompletionError } from "./types";

export type CompletionPrepareError = {
	message: string;
	status: number;
	code?: string;
	reason?: string;
};

export type StructuredOutputRequirementResult = ReturnType<
	typeof buildStructuredOutputRequirement
>;

export type PromptToolChoice = "auto" | "none" | "required";

export type CompletionStreamMode =
	| { type: "plain" }
	| { type: "tool_sieve"; tools: ToolBundle };

export type PreparedCompletion = {
	rm: ResolvedModelOk;
	bundle: ToolBundle;
	tools: ToolBundle | null;
	streamMode: CompletionStreamMode;
	toolPolicy: ToolChoicePolicy;
	promptToolChoice: PromptToolChoice;
	structured: StructuredOutputRequirementResult;
	prompt: string;
	fileRefs: FileRef[] | null;
	promptTokens: number;
	contextFiles: ContextFileResult | null;
};

type PrepareContextArgs = {
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	req: UnknownRecord;
	messages: readonly InternalMessage[];
	bundle: ToolBundle;
	filtered: ToolBundle;
	toolPolicy: ToolChoicePolicy;
	promptToolChoice: PromptToolChoice;
	hasTools: boolean;
	choiceInstruction: string;
	structured: StructuredOutputRequirementResult;
};

export type CompletionDialect = {
	stage: "openai" | "google";
	modelLogLabel(model: unknown): string;
	structured(req: UnknownRecord): StructuredOutputRequirementResult;
	parsePolicy(req: UnknownRecord, bundle: ToolBundle): ToolChoicePolicy;
	choiceInstruction(policy: ToolChoicePolicy): string;
	emptyPromptMessage: string;
	defaultPrepareErrorCode: string | null;
	promptToolSource(
		bundle: ToolBundle,
		filtered: ToolBundle,
		policy: ToolChoicePolicy,
	): ToolBundle | null;
	prepareContext(args: PrepareContextArgs): Promise<GeminiContextPrepareResult>;
};

export const OPENAI_COMPLETION_DIALECT: CompletionDialect = {
	stage: "openai",
	modelLogLabel: (model) => String(model ?? "(default)"),
	structured: (req) =>
		buildStructuredOutputRequirement(getStructuredResponseFormat(req)),
	parsePolicy: (req, bundle) =>
		parseOpenAIToolChoicePolicy(
			req.tool_choice != null ? req.tool_choice : "auto",
			bundle,
		),
	choiceInstruction: (policy) => buildToolChoiceInstructionFromPolicy(policy),
	emptyPromptMessage: "empty prompt",
	defaultPrepareErrorCode: null,
	promptToolSource: (bundle, filtered, policy) => {
		if (policy.mode === "none") return null;
		return filtered.defs.length ? filtered : bundle;
	},
	prepareContext: (args) =>
		prepareOpenAIGeminiContext(
			args.cfg,
			args.provider,
			args.req,
			args.messages,
			args.filtered,
			args.promptToolChoice,
			args.toolPolicy,
			args.structured,
		),
};

export const GOOGLE_COMPLETION_DIALECT: CompletionDialect = {
	stage: "google",
	modelLogLabel: (model) => String(model || "(empty)"),
	structured: () => null,
	parsePolicy: (req, bundle) => parseGoogleToolChoicePolicy(req, bundle),
	choiceInstruction: (policy) => googleToolChoiceInstructionFromPolicy(policy),
	emptyPromptMessage: "empty content",
	defaultPrepareErrorCode: "context_file_upload_failed",
	promptToolSource: (bundle, filtered) =>
		filtered.defs.length ? filtered : bundle,
	prepareContext: (args) =>
		prepareGoogleGeminiContext(
			args.cfg,
			args.provider,
			args.messages,
			args.hasTools,
			args.filtered,
			args.choiceInstruction,
		),
};

export type PrepareCompletionOptions = {
	emptyPromptMessage?: string;
};

export async function prepareCompletion(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	req: UnknownRecord,
	messages: readonly InternalMessage[],
	model: unknown,
	dialect: CompletionDialect,
	options: PrepareCompletionOptions = {},
): Promise<PreparedCompletion | { error: CompletionPrepareError }> {
	const rm = await provider.resolveModel(model, cfg.default_model);
	if (rm.name === undefined) {
		log(
			cfg,
			`${dialect.stage} completion model rejected model=${dialect.modelLogLabel(model)}`,
		);
		return {
			error: { message: rm.error, status: 400, code: "model_not_found" },
		};
	}

	const structured = dialect.structured(req);
	if (structured?.error) {
		return {
			error: {
				message: structured.error,
				status: 400,
				code: "invalid_response_format",
			},
		};
	}

	const bundle = createToolBundle(req.tools);
	const toolPolicy = dialect.parsePolicy(req, bundle);
	if (toolPolicy.error) {
		return {
			error: {
				message: toolPolicy.error,
				status: 400,
				code: "invalid_tool_choice",
			},
		};
	}

	const filtered = filterToolBundleByPolicy(bundle, toolPolicy);
	const tools = filtered.openAIFunctionTools.length ? filtered : null;
	let promptToolChoice: PromptToolChoice = "auto";
	if (toolPolicy.mode === "none") promptToolChoice = "none";
	else if (toolPolicy.mode === "required" || toolPolicy.mode === "forced")
		promptToolChoice = "required";
	const hasTools = !!tools && promptToolChoice !== "none";
	const streamMode: CompletionStreamMode =
		toolPolicy.mode === "none"
			? bundle.openAIFunctionTools.length
				? { type: "tool_sieve", tools: bundle }
				: { type: "plain" }
			: tools
				? { type: "tool_sieve", tools }
				: { type: "plain" };
	const choiceInstruction = dialect.choiceInstruction(toolPolicy);

	const ctx = await dialect.prepareContext({
		cfg,
		provider,
		req,
		messages,
		bundle,
		filtered,
		toolPolicy,
		promptToolChoice,
		hasTools,
		choiceInstruction,
		structured,
	});
	if (hasCompletionError(ctx)) {
		const code =
			upstreamErrorCode(ctx.error) || dialect.defaultPrepareErrorCode || "";
		const reason = upstreamErrorReason(ctx.error);
		const error: CompletionPrepareError = {
			message: upstreamErrorMessage(ctx.error),
			status: upstreamErrorStatus(ctx.error) || 502,
		};
		if (code) error.code = code;
		if (reason) error.reason = reason;
		return { error };
	}

	const prompt = ensureInlineToolPrompt(
		ctx.prompt,
		dialect.promptToolSource(bundle, filtered, toolPolicy),
		choiceInstruction,
		ctx.contextFiles,
		ctx.promptMetadata,
	);
	if (!String(prompt || "").trim()) {
		return {
			error: {
				message: options.emptyPromptMessage ?? dialect.emptyPromptMessage,
				status: 400,
			},
		};
	}

	return {
		rm,
		bundle,
		tools,
		streamMode,
		toolPolicy,
		promptToolChoice,
		structured,
		prompt,
		fileRefs: ctx.fileRefs,
		promptTokens: ctx.promptTokens,
		contextFiles: ctx.contextFiles,
	};
}

export function ensureInlineToolPrompt(
	prompt: string,
	tools: ToolBundle | null | undefined,
	toolChoiceInstruction: string,
	contextFiles: unknown,
	metadata: PromptMetadata,
): string {
	const text = String(prompt || "");
	const toolNames = toolNamesForPromptSource(tools);
	if (contextFiles) {
		if (metadata.hasToolInstructions) return text;
		if (!toolNames.length)
			return withMissingInstruction(text, toolChoiceInstruction);
		return [toolCallInstructionsFor(tools), toolChoiceInstruction, text]
			.filter((part) => part.trim())
			.join("\n\n");
	}
	if (!toolNames.length) {
		return withMissingInstruction(text, toolChoiceInstruction);
	}
	if (metadata.hasToolPrompt && metadata.hasToolInstructions) return text;
	return [toolPromptBlockFor(tools, toolChoiceInstruction), text]
		.filter((part) => part.trim())
		.join("\n\n");
}

function withMissingInstruction(text: string, instruction: string): string {
	const trimmed = String(instruction || "").trim();
	if (!trimmed || text.includes(trimmed)) return text;
	return [instruction, text].filter((part) => part.trim()).join("\n\n");
}
