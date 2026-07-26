import {
	type AttachmentLimits,
	DEFAULT_ATTACHMENT_MAX_BYTES,
	type MaterializedAttachment,
	materializeAttachment,
} from "../../attachments/materialize";
import { normalizeMimeType } from "../../attachments/bytes";
import { attachmentDrop, droppedAttachmentNote } from "../../attachments/plan";
import type {
	AttachmentCandidate,
	AttachmentFileRef,
	AttachmentPlan,
	AttachmentDrop,
	AttachmentUploadResult,
	AttachmentUsage,
} from "../../attachments/types";
import type { RuntimeConfig } from "../../config";
import { bytesToHex } from "../../shared/crypto";
import { TEXT_ENCODER, UTF8_FATAL_DECODER } from "../../shared/encoding";
import { errorLogSummary } from "../../shared/errors";
import { log, logStage } from "../../shared/logging";
import { firstNonEmptyString } from "../../shared/strings";
import { mapWithConcurrencyAndWeight } from "../concurrency";
import { configWithFreshGeminiCookie } from "../cookies";
import { uploadMultipartFile } from "./multipart";

const MAX_PARALLEL_UPLOADS = 4;
const MAX_IN_FLIGHT_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export class AttachmentExecutionState {
	private readonly uploadedByKey = new Map<string, AttachmentFileRef>();
	private readonly pendingByKey = new Map<string, Promise<AttachmentFileRef>>();
	private readonly inlinedByKey = new Map<string, string>();
	private uploadedFiles = 0;
	private dedupedFiles = 0;
	private uploadedBytes = 0;
	private inlinedFiles = 0;
	private inlinedBytes = 0;
	private multipartUploads = 0;

	async resolveUploaded(
		key: string,
		bytesLength: number,
		upload: () => Promise<AttachmentFileRef>,
	): Promise<AttachmentFileRef> {
		const existing = this.uploadedByKey.get(key);
		if (existing) {
			this.dedupedFiles += 1;
			return existing;
		}
		const pending = this.pendingByKey.get(key);
		if (pending) {
			const fileRef = await pending;
			this.dedupedFiles += 1;
			return fileRef;
		}

		const uploadPromise = upload();
		this.pendingByKey.set(key, uploadPromise);
		try {
			const fileRef = await uploadPromise;
			this.uploadedByKey.set(key, fileRef);
			this.uploadedFiles += 1;
			this.uploadedBytes += bytesLength;
			this.multipartUploads += 1;
			return fileRef;
		} finally {
			if (this.pendingByKey.get(key) === uploadPromise)
				this.pendingByKey.delete(key);
		}
	}

	rememberInline(key: string, promptText: string, bytesLength: number): string {
		if (this.inlinedByKey.has(key)) {
			this.dedupedFiles += 1;
			return "";
		}
		this.inlinedByKey.set(key, promptText);
		this.inlinedFiles += 1;
		this.inlinedBytes += bytesLength;
		return promptText;
	}

	usage(fileRefBytes: number, droppedFiles: number): AttachmentUsage {
		return {
			uploadedFiles: this.uploadedFiles,
			dedupedFiles: this.dedupedFiles,
			uploadedBytes: this.uploadedBytes,
			fileRefBytes,
			inlinedFiles: this.inlinedFiles,
			inlinedBytes: this.inlinedBytes,
			droppedFiles,
			multipartUploads: this.multipartUploads,
		};
	}
}

export function attachmentLimitsFromConfig(
	cfg: RuntimeConfig,
): AttachmentLimits {
	const configuredMaxBytes = Number(cfg.generic_file_upload_max_bytes);
	const maxBytes = Number.isFinite(configuredMaxBytes)
		? Math.max(0, Math.floor(configuredMaxBytes))
		: DEFAULT_ATTACHMENT_MAX_BYTES;
	return { maxFileBytes: maxBytes, maxImageBytes: maxBytes };
}

export function mapAttachmentCandidates<R>(
	candidates: readonly AttachmentCandidate[],
	mapper: (candidate: AttachmentCandidate, index: number) => Promise<R>,
): Promise<R[]> {
	return mapWithConcurrencyAndWeight(
		candidates,
		MAX_PARALLEL_UPLOADS,
		MAX_IN_FLIGHT_ATTACHMENT_BYTES,
		estimatedMaterializedBytes,
		mapper,
	);
}

export async function attachmentDedupeKey(
	materialized: MaterializedAttachment,
): Promise<string> {
	const digestInput =
		materialized.bytes.buffer instanceof ArrayBuffer
			? (materialized.bytes as Uint8Array<ArrayBuffer>)
			: new Uint8Array(materialized.bytes);
	const digest = await crypto.subtle.digest("SHA-256", digestInput);
	return `${materialized.mime}\x00${materialized.filename}\x00${bytesToHex(new Uint8Array(digest))}`;
}

function estimatedMaterializedBytes(candidate: AttachmentCandidate): number {
	if (candidate.source.type === "bytes")
		return candidate.source.bytes.byteLength;
	return Math.floor((String(candidate.source.data || "").length * 3) / 4);
}

export type AttachmentCandidateResult = {
	candidate: AttachmentCandidate;
	fileRef: AttachmentFileRef | null;
	promptText: string;
	drop: AttachmentDrop | null;
	bytesLength: number;
	failureSummary?: string;
};

export function aggregateAttachmentResults(
	cfg: RuntimeConfig,
	plan: AttachmentPlan,
	results: readonly AttachmentCandidateResult[],
	state: AttachmentExecutionState,
	supportsFileRefs: boolean,
): AttachmentUploadResult {
	const fileRefs: AttachmentFileRef[] = [];
	const imageFileRefs: AttachmentFileRef[] = [];
	const genericFileRefs: AttachmentFileRef[] = [];
	const promptParts: string[] = [];
	const drops = [...plan.dropped];
	let fileRefBytes = 0;

	for (const result of results) {
		if (result.drop) {
			drops.push(result.drop);
			log(
				cfg,
				`attachment upload dropped kind=${result.candidate.kind} bytes=${result.bytesLength || "unknown"} ${result.failureSummary || errorLogSummary(result.drop.message)}`,
			);
			continue;
		}
		if (result.promptText) promptParts.push(result.promptText);
		if (!result.fileRef) continue;
		fileRefBytes += result.bytesLength;
		fileRefs.push(result.fileRef);
		if (result.candidate.kind === "image") imageFileRefs.push(result.fileRef);
		else genericFileRefs.push(result.fileRef);
	}

	const usage = state.usage(fileRefBytes, drops.length);
	if (cfg.log_requests) {
		logStage(cfg, "attachment_upload", {
			candidates: plan.candidates.length,
			existingRefs: plan.existingFileRefs ? plan.existingFileRefs.length : 0,
			uploadedFiles: usage.uploadedFiles,
			dedupedFiles: usage.dedupedFiles,
			uploadedBytes: usage.uploadedBytes,
			fileRefBytes: usage.fileRefBytes,
			inlinedFiles: usage.inlinedFiles,
			inlinedBytes: usage.inlinedBytes,
			droppedFiles: usage.droppedFiles,
			multipartUploads: usage.multipartUploads,
			supportsFileRefs,
		});
	}

	return {
		fileRefs: fileRefs.length ? fileRefs : null,
		imageFileRefs: imageFileRefs.length ? imageFileRefs : null,
		genericFileRefs: genericFileRefs.length ? genericFileRefs : null,
		promptText: promptParts.join(""),
		droppedNote: droppedAttachmentNote(drops),
		supportsFileRefs,
		usage,
	};
}

export function attachmentCandidateDrop(
	candidate: AttachmentCandidate,
	message: string,
	bytesLength: number,
	filename: unknown = candidate.filename,
): AttachmentCandidateResult {
	return {
		candidate,
		fileRef: null,
		promptText: "",
		drop: attachmentDrop(candidate.kind, "upload_failed", message, filename),
		bytesLength,
		failureSummary: errorLogSummary(message),
	};
}

export function attachmentCandidateFailure(
	candidate: AttachmentCandidate,
	error: unknown,
	materialized: MaterializedAttachment | null,
): AttachmentCandidateResult {
	const code = dropCodeFromError(candidate, error);
	return {
		candidate,
		fileRef: null,
		promptText: "",
		drop: attachmentDrop(
			candidate.kind,
			code,
			dropMessageFromError(code, error),
			candidate.filename,
		),
		bytesLength: materialized ? materialized.bytes.byteLength : 0,
		failureSummary: errorLogSummary(error),
	};
}

function dropCodeFromError(
	candidate: AttachmentCandidate,
	error: unknown,
): AttachmentDrop["code"] {
	const code =
		error && typeof error === "object"
			? String((error as { code?: unknown }).code || "")
			: "";
	switch (code) {
		case "invalid_base64":
		case "invalid_remote_url":
		case "file_too_large":
		case "image_too_large":
			return code;
		default:
			return candidate.kind === "image" && code === "invalid_image_input"
				? "invalid_image_input"
				: "upload_failed";
	}
}

function dropMessageFromError(
	code: AttachmentDrop["code"],
	error: unknown,
): string {
	const message =
		error && typeof error === "object" && "message" in error
			? firstNonEmptyString((error as { message?: unknown }).message)
			: "";
	switch (code) {
		case "invalid_base64":
			return "invalid base64 payload";
		case "invalid_remote_url":
			return "invalid remote URL";
		case "file_too_large":
			return message || "file attachment is too large";
		case "image_too_large":
			return message || "image attachment is too large";
		case "invalid_image_input":
			return "invalid image input";
		case "invalid_file_input":
			return "invalid file input";
		case "too_many_files":
			return "too many attachments";
		case "upload_failed":
			return "attachment upload failed";
	}
}

export function resolveAttachmentCandidate(
	cfg: RuntimeConfig,
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
	state: AttachmentExecutionState,
	supportsFileRefs: boolean,
): Promise<AttachmentCandidateResult> {
	return supportsFileRefs
		? uploadAttachmentCandidate(cfg, candidate, limits, state)
		: inlineOrDropAnonymousAttachment(candidate, limits, state);
}

async function uploadAttachmentCandidate(
	cfg: RuntimeConfig,
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
	state: AttachmentExecutionState,
): Promise<AttachmentCandidateResult> {
	let materialized: MaterializedAttachment | null = null;
	try {
		materialized = await materializeAttachment(candidate, limits);
		const key = await attachmentDedupeKey(materialized);
		const uploadInput = {
			bytes: materialized.bytes,
			mime: materialized.mime,
			filename: materialized.filename,
		};
		const fileRef = await state.resolveUploaded(
			key,
			materialized.bytes.byteLength,
			async () => ({
				ref: await uploadMultipartFile(cfg, uploadInput),
				name: uploadInput.filename,
			}),
		);
		return {
			candidate,
			fileRef,
			promptText: "",
			drop: null,
			bytesLength: materialized.bytes.byteLength,
		};
	} catch (error) {
		return attachmentCandidateFailure(candidate, error, materialized);
	}
}

async function inlineOrDropAnonymousAttachment(
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
	state: AttachmentExecutionState,
): Promise<AttachmentCandidateResult> {
	let materialized: MaterializedAttachment | null = null;
	try {
		materialized = await materializeAttachment(candidate, limits);
		if (candidate.kind !== "file") {
			return attachmentCandidateDrop(
				candidate,
				"image input requires a configured Gemini account pool",
				materialized.bytes.byteLength,
				materialized.filename,
			);
		}
		const inlineText = anonymousInlineTextFor(materialized);
		if (inlineText == null) {
			return attachmentCandidateDrop(
				candidate,
				"file attachment requires a configured Gemini account pool",
				materialized.bytes.byteLength,
				materialized.filename,
			);
		}
		const key = await attachmentDedupeKey(materialized);
		const promptText = state.rememberInline(
			key,
			formatInlineAttachmentText(materialized.filename, inlineText),
			materialized.bytes.byteLength,
		);
		return {
			candidate,
			fileRef: null,
			promptText,
			drop: null,
			bytesLength: materialized.bytes.byteLength,
		};
	} catch (error) {
		return attachmentCandidateFailure(candidate, error, materialized);
	}
}

function anonymousInlineTextFor(
	materialized: MaterializedAttachment,
): string | null {
	const mime = normalizeMimeType(materialized.mime);
	if (!isInlineTextMime(mime)) return null;
	try {
		return UTF8_FATAL_DECODER.decode(materialized.bytes);
	} catch (_) {
		return null;
	}
}

function isInlineTextMime(mime: string): boolean {
	return (
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/x-ndjson" ||
		mime === "application/xml"
	);
}

function formatInlineAttachmentText(filename: string, text: string): string {
	return `\n\n[File attachment: ${filename}]\n${text}\n[/File attachment]`;
}

export async function resolveAttachments(
	cfg: RuntimeConfig,
	plan: AttachmentPlan,
): Promise<AttachmentUploadResult> {
	const activeConfig = await configWithFreshGeminiCookie(cfg);
	const supportsFileRefs = !!activeConfig.cookie;
	const state = new AttachmentExecutionState();
	const limits = attachmentLimitsFromConfig(activeConfig);
	const results = await mapAttachmentCandidates(plan.candidates, (candidate) =>
		resolveAttachmentCandidate(
			activeConfig,
			candidate,
			limits,
			state,
			supportsFileRefs,
		),
	);
	return aggregateAttachmentResults(
		activeConfig,
		plan,
		results,
		state,
		supportsFileRefs,
	);
}

export async function uploadTextFile(
	cfg: RuntimeConfig,
	text: unknown,
	filename: unknown,
): Promise<AttachmentFileRef> {
	const activeConfig = await configWithFreshGeminiCookie(cfg);
	const name = String(filename || "context.txt").trim() || "context.txt";
	try {
		const ref = await uploadMultipartFile(activeConfig, {
			bytes: TEXT_ENCODER.encode(String(text || "")),
			mime: "text/plain; charset=utf-8",
			filename: name,
		});
		return { ref, name };
	} catch (error) {
		log(activeConfig, `multipart upload failed ${errorLogSummary(error)}`);
		throw error;
	}
}
