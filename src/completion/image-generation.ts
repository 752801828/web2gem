import { MAX_ATTACHMENTS_PER_REQUEST } from "../attachments/plan";
import type { AttachmentFileRef, AttachmentPlan } from "../attachments/types";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import type { InternalMessage } from "../promptcompat/message-model";
import {
	geminiAuthenticatedSessionRequiredError,
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
	upstreamErrorStatus,
} from "../shared/errors";
import { log } from "../shared/logging";
import { tokenEst } from "../promptcompat/token-accounting";
import { promptByteLength } from "../shared/text-metrics";
import type { UnknownRecord } from "../shared/types";
import { contextFileThreshold } from "./context-files";
import {
	type ExtractionState,
	type ImageGenerationPrepareError,
	type ImageGenerationUserImageInput,
	extractFromLatestChatUserMessage,
	extractFromResponseMessages,
	extractFromUserInput,
} from "./image-generation-extract";
import type { CompletionProvider } from "./ports";
import type { AttachmentResolutionResult, FileRef } from "./types";

export type {
	ImageGenerationByteInput,
	ImageGenerationPrepareError,
	ImageGenerationUserImageInput,
} from "./image-generation-extract";

export type PreparedImageGenerationCompletion = {
	rm: Extract<ResolvedModel, { name: string }>;
	prompt: string;
	userPrompt: string;
	fileRefs: FileRef[] | null;
	promptTokens: number;
};

export type ImageGenerationRouteKind = "responses" | "chat";

export type OpenAIImageGenerationUserInput = {
	model?: unknown;
	prompt: unknown;
	imageInputs?: readonly ImageGenerationUserImageInput[];
};

const IMAGE_GENERATION_INSTRUCTION = [
	"IMAGE GENERATION ENABLED: Return a real generated image matching the user's request.",
	"For edits to attached images, apply the requested changes and return a new generated version.",
	"Do not provide explanations, process notes, placeholders, or apologies without an actual generated image attachment.",
].join("\n");

const FORCED_IMAGE_GENERATION_INSTRUCTION =
	"Image generation was explicitly requested. Return at least one generated image; a response without a generated image is a failure.";

export async function prepareOpenAIImageGenerationCompletion(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	req: UnknownRecord,
	route: ImageGenerationRouteKind,
	forced: boolean,
	messages: readonly InternalMessage[],
): Promise<
	PreparedImageGenerationCompletion | { error: ImageGenerationPrepareError }
> {
	const state =
		route === "responses"
			? extractFromResponseMessages(messages)
			: extractFromLatestChatUserMessage(messages);
	return prepareImageGenerationFromState(
		cfg,
		provider,
		req.model,
		state,
		forced,
	);
}

export async function prepareOpenAIImageGenerationFromUserInput(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	input: OpenAIImageGenerationUserInput,
	forced: boolean,
): Promise<
	PreparedImageGenerationCompletion | { error: ImageGenerationPrepareError }
> {
	const state = extractFromUserInput(input.prompt, input.imageInputs);
	return prepareImageGenerationFromState(
		cfg,
		provider,
		input.model,
		state,
		forced,
	);
}

async function prepareImageGenerationFromState(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	model: unknown,
	state: ExtractionState,
	forced: boolean,
): Promise<
	PreparedImageGenerationCompletion | { error: ImageGenerationPrepareError }
> {
	if (!provider.supportsAuthenticatedSession) {
		const error = geminiAuthenticatedSessionRequiredError("image");
		const preparedError: ImageGenerationPrepareError = {
			message: error.message,
			status: error.status || 422,
			code: error.code || "gemini_authenticated_session_required",
		};
		if (error.reason) preparedError.reason = error.reason;
		return {
			error: preparedError,
		};
	}

	const rm = await provider.resolveModel(model, cfg.default_model);
	if (rm.name === undefined) {
		log(
			cfg,
			`openai image generation model rejected model=${String(model ?? "(default)")}`,
		);
		return {
			error: { message: rm.error, status: 400, code: "model_not_found" },
		};
	}

	if (state.error) return { error: state.error };

	const userPrompt = state.textParts
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n")
		.trim();
	if (!userPrompt) {
		return {
			error: {
				message: "image generation requires non-empty user prompt text",
				status: 400,
				code: "image_generation_empty_prompt",
			},
		};
	}

	const prompt = [
		userPrompt,
		IMAGE_GENERATION_INSTRUCTION,
		forced ? FORCED_IMAGE_GENERATION_INSTRUCTION : "",
	]
		.filter(Boolean)
		.join("\n\n");
	const promptBytes = promptByteLength(prompt);
	const threshold = contextFileThreshold(cfg);
	if (promptBytes > threshold) {
		return {
			error: {
				message: `image generation prompt is too large for pass-through mode (${promptBytes} UTF-8 bytes > ${threshold})`,
				status: 413,
				code: "image_generation_prompt_too_large",
			},
		};
	}

	const fileRefsResult = await resolveImageGenerationFileRefs(provider, state);
	if ("error" in fileRefsResult) return fileRefsResult;

	return {
		rm,
		prompt,
		userPrompt,
		fileRefs: fileRefsResult.fileRefs,
		promptTokens: tokenEst(prompt),
	};
}

async function resolveImageGenerationFileRefs(
	provider: CompletionProvider,
	state: ExtractionState,
): Promise<
	{ fileRefs: FileRef[] | null } | { error: ImageGenerationPrepareError }
> {
	if (
		!state.candidates.length &&
		!state.slots.some((slot) => slot.type === "existing")
	)
		return { fileRefs: null };
	const plan: AttachmentPlan = {
		candidates: state.candidates,
		existingFileRefs: state.slots
			.filter(
				(slot): slot is { type: "existing"; ref: AttachmentFileRef } =>
					slot.type === "existing",
			)
			.map((slot) => slot.ref),
		dropped: [],
		maxFiles: MAX_ATTACHMENTS_PER_REQUEST,
	};
	let result: AttachmentResolutionResult;
	try {
		result = await provider.resolveAttachments(plan);
	} catch (e) {
		const error: ImageGenerationPrepareError = {
			message: `failed to upload image generation input: ${upstreamErrorMessage(e)}`,
			status: upstreamErrorStatus(e) || 502,
			code: upstreamErrorCode(e) || "image_input_upload_failed",
		};
		const reason = upstreamErrorReason(e);
		if (reason) error.reason = reason;
		return {
			error,
		};
	}
	const uploaded = result.fileRefs || [];
	const out: FileRef[] = [];
	for (const slot of state.slots) {
		if (slot.type === "existing") {
			out.push(slot.ref);
			continue;
		}
		const ref = uploaded[slot.index];
		if (!ref) {
			return {
				error: {
					message: "failed to upload image generation input",
					status: 502,
					code: "image_input_upload_failed",
				},
			};
		}
		out.push(ref);
	}
	return { fileRefs: out.length ? out : null };
}
