import type {
	CompletionProvider,
	CompletionTextInput,
} from "../../completion/ports";
import {
	finalizeOpenAICompletionResult,
	type OpenAICompletionTurn,
	type OpenAICompletionTurnOptions,
} from "../../completion/turn";
import type { RuntimeConfig } from "../../config";
import { log } from "../../shared/logging";
import { generateTextLogged, type StageLog } from "../generation";
import { OPENAI_GENERATION_PROTOCOL, openAIErrorResponse } from "./errors";

type OpenAICompletionSuccess = Extract<OpenAICompletionTurn, { text: string }>;

export type OpenAICompletionFinalizeResult =
	| { turn: OpenAICompletionSuccess; response?: undefined }
	| { response: Response; turn?: undefined };

/**
 * Shared non-stream OpenAI generate + finalize used by chat and responses.
 * Endpoint adapters still own IDs, payloads, usage, and timestamps.
 */
export async function generateOpenAICompletionFinalize(args: {
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	stage: string;
	logLabel: string;
	stageLog: StageLog;
	input: CompletionTextInput & { rm: { name: string } };
	options: OpenAICompletionTurnOptions;
	okLogFields: (text: string) => Record<string, unknown>;
}): Promise<OpenAICompletionFinalizeResult> {
	const generated = await generateTextLogged({
		cfg: args.cfg,
		provider: args.provider,
		stage: args.stage,
		logLabel: args.logLabel,
		protocol: OPENAI_GENERATION_PROTOCOL,
		stageLog: args.stageLog,
		input: args.input,
		okLogFields: args.okLogFields,
	});
	if (generated.response) return generated;

	const finalized = finalizeOpenAICompletionResult(
		generated.text,
		args.options,
	);
	if (finalized.error) {
		if (finalized.error.code === "upstream_empty")
			log(
				args.cfg,
				`${args.logLabel} generate produced no content model=${args.input.rm.name}`,
			);
		return {
			response: openAIErrorResponse(
				finalized.error.message,
				finalized.error.status,
				finalized.error.code,
			),
		};
	}
	return { turn: finalized };
}
