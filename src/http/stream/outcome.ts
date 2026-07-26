import { EMPTY_UPSTREAM_MSG } from "../../completion/turn";
import type {
	CompletionStreamIssue,
	CompletionStreamOutcome,
} from "../../completion/stream-events";
import type { RuntimeConfig } from "../../config";
import { errorLogSummary, upstreamErrorCode } from "../../shared/errors";
import { log } from "../../shared/logging";
import type { ToolPolicyViolation } from "../../toolcall/policy";

export const EMPTY_UPSTREAM_STREAM_ERROR = {
	message: EMPTY_UPSTREAM_MSG,
	code: "upstream_empty",
} as const;

export type StreamOutcomePolicyLogKind =
	| "tool policy violation"
	| "policy violation";

export type StreamOutcomeHandlers = {
	onFailedBeforeOutput: (issue: CompletionStreamIssue) => void | Promise<void>;
	onEmpty: () => void | Promise<void>;
	onPolicyViolation?: (violation: ToolPolicyViolation) => void | Promise<void>;
	/**
	 * Called for partial-output interruptions. Logging is owned by this helper
	 * unless `logInterrupted` is false (caller logs a specialized message).
	 */
	onInterruptedAfterOutput?: (
		issue: CompletionStreamIssue,
	) => void | Promise<void>;
};

/**
 * Shared protocol-adapter stream outcome shell: log terminal lifecycle outcomes
 * once, then dispatch protocol-specific frame writers. Returns true when the
 * caller should stop (failed / empty / policy).
 *
 * Callers must flush any delta coalescer before invoking this helper so partial
 * buffered text is emitted before terminal frames.
 */
export async function handleCompletionStreamOutcome(args: {
	cfg: RuntimeConfig;
	/** Log label prefix, e.g. "openai chat stream" or "google tool stream". */
	label: string;
	model: string;
	outcome: CompletionStreamOutcome;
	handlers: StreamOutcomeHandlers;
	policyLogKind?: StreamOutcomePolicyLogKind;
	/** Default true. Set false when the handler logs a specialized interrupt line. */
	logInterrupted?: boolean;
}): Promise<boolean> {
	const {
		cfg,
		label,
		model,
		outcome,
		handlers,
		policyLogKind = "tool policy violation",
		logInterrupted = true,
	} = args;

	if (outcome.type === "failed_before_output") {
		const error = outcome.issue.error;
		log(
			cfg,
			`${label} failed before output model=${model} code=${upstreamErrorCode(error) || "upstream_error"} error=${errorLogSummary(error)}`,
		);
		await handlers.onFailedBeforeOutput(outcome.issue);
		return true;
	}
	if (outcome.type === "policy_violation") {
		log(
			cfg,
			`${label} ${policyLogKind} model=${model} code=${outcome.violation.code}`,
		);
		if (handlers.onPolicyViolation)
			await handlers.onPolicyViolation(outcome.violation);
		return true;
	}
	if (outcome.type === "empty") {
		log(cfg, `${label} produced no content model=${model}`);
		await handlers.onEmpty();
		return true;
	}
	if (outcome.type === "interrupted_after_output") {
		if (logInterrupted) {
			const error = outcome.issue.error;
			log(
				cfg,
				`${label} interrupted after partial output model=${model} code=${upstreamErrorCode(error) || "stream_interrupted"} error=${errorLogSummary(error)}`,
			);
		}
		if (handlers.onInterruptedAfterOutput)
			await handlers.onInterruptedAfterOutput(outcome.issue);
	}
	return false;
}
