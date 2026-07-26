import { base64ToBytes } from "../attachments/bytes";
import {
	detectUploadMimeFromBytes,
	imageFilenameFromMime,
	normalizeMimeType,
	sanitizeUploadFilename,
} from "../attachments/bytes";
import { MAX_ATTACHMENTS_PER_REQUEST } from "../attachments/plan";
import type {
	AttachmentCandidate,
	AttachmentFileRef,
} from "../attachments/types";
import { parseMessagePart } from "../promptcompat/message-model";
import type {
	FilePart,
	ImagePart,
	InternalMessage,
	MessagePart,
} from "../promptcompat/message-model";
import { firstNonEmptyString } from "../shared/strings";
import type { UnknownRecord } from "../shared/types";

export type ImageGenerationPrepareError = {
	message: string;
	status: number;
	code: string;
	reason?: string;
};

export type ImageGenerationByteInput = {
	bytes: Uint8Array;
	filename?: string;
	mime?: string;
};

export type ImageGenerationUserImageInput =
	| { type: "part"; part: UnknownRecord }
	| { type: "bytes"; image: ImageGenerationByteInput };

export type FileSlot =
	| { type: "existing"; ref: AttachmentFileRef }
	| { type: "candidate"; index: number };

export type ExtractionState = {
	textParts: string[];
	candidates: AttachmentCandidate[];
	slots: FileSlot[];
	error: ImageGenerationPrepareError | null;
	nextID: number;
};

export function createExtractionState(): ExtractionState {
	return { textParts: [], candidates: [], slots: [], error: null, nextID: 1 };
}

export function extractFromResponseMessages(
	messages: readonly InternalMessage[],
): ExtractionState {
	const state = createExtractionState();
	for (const message of messages) {
		if (state.error) return state;
		if (message.role === "user") appendMessageParts(state, message);
	}
	return state;
}

export function extractFromLatestChatUserMessage(
	messages: readonly InternalMessage[],
): ExtractionState {
	const state = createExtractionState();
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "user") {
			appendMessageParts(state, message);
			return state;
		}
	}
	return state;
}

export function extractFromUserInput(
	prompt: unknown,
	imageInputs: readonly ImageGenerationUserImageInput[] | undefined,
): ExtractionState {
	const state = createExtractionState();
	appendText(state, prompt);
	for (const imageInput of imageInputs || []) {
		if (state.error) break;
		if (imageInput.type === "part") appendUserImagePart(state, imageInput.part);
		else appendImageBytes(state, imageInput.image);
	}
	return state;
}

function appendMessageParts(
	state: ExtractionState,
	message: InternalMessage,
): void {
	for (const part of message.parts) {
		if (state.error) return;
		appendModelPart(state, part);
	}
}

function appendModelPart(
	state: ExtractionState,
	part: MessagePart | null,
): void {
	if (state.error || !part) return;
	if (part.kind === "text") {
		if (part.inputText) appendText(state, part.text);
		return;
	}
	if (part.kind === "reasoning") return;
	if (part.kind === "image") {
		appendImagePart(state, part);
		return;
	}
	appendFilePart(state, part);
}

/** `/v1/images/*` part inputs: already image-shaped records from images-input. */
function appendUserImagePart(state: ExtractionState, raw: UnknownRecord): void {
	const part = parseMessagePart(raw);
	if (part && (part.kind === "image" || part.kind === "file")) {
		appendModelPart(state, part);
		return;
	}
	state.error = unsupportedImageInput(
		"image input must be an inline image payload or existing file reference",
	);
}

function appendText(state: ExtractionState, value: unknown): void {
	const text =
		typeof value === "string" || typeof value === "number"
			? String(value).trim()
			: "";
	if (text) state.textParts.push(text);
}

function appendImagePart(state: ExtractionState, part: ImagePart): void {
	if (part.remoteUrl) {
		state.error = unsupportedImageInput(
			"remote image/file URLs are not supported in image generation mode",
		);
		return;
	}
	if (part.fileRef && !part.hasInline) {
		state.slots.push({ type: "existing", ref: part.fileRef });
		return;
	}
	if (!part.hasInline) {
		state.error = unsupportedImageInput(
			"image input must be an inline image payload or existing file reference",
		);
		return;
	}
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(part.b64);
	} catch (_) {
		state.error = unsupportedImageInput("invalid image base64 payload");
		return;
	}
	const detected = detectUploadMimeFromBytes(bytes);
	if (!normalizeMimeType(detected).startsWith("image/")) {
		state.error = unsupportedImageInput(
			"image input bytes are not a supported image",
		);
		return;
	}
	const mime = firstNonEmptyString(detected, part.mime, "image/png");
	const candidate: AttachmentCandidate = {
		id: `att_${state.nextID}`,
		kind: "image",
		role: "request",
		source: { type: "bytes", bytes },
	};
	const filename = firstNonEmptyString(
		part.filename,
		imageFilenameFromMime(mime, state.nextID),
	);
	if (filename) candidate.filename = filename;
	if (mime) candidate.mime = mime;
	addCandidateSlot(state, candidate);
}

function appendImageBytes(
	state: ExtractionState,
	image: ImageGenerationByteInput,
): void {
	const detected = detectUploadMimeFromBytes(image.bytes);
	if (!normalizeMimeType(detected).startsWith("image/")) {
		state.error = unsupportedImageInput(
			"image input bytes are not a supported image",
		);
		return;
	}
	const mime = firstNonEmptyString(detected, image.mime, "image/png");
	const candidate: AttachmentCandidate = {
		id: `att_${state.nextID}`,
		kind: "image",
		role: "request",
		source: { type: "bytes", bytes: image.bytes },
	};
	const filename = firstNonEmptyString(
		sanitizeUploadFilename(image.filename),
		imageFilenameFromMime(mime, state.nextID),
	);
	if (filename) candidate.filename = filename;
	if (mime) candidate.mime = mime;
	addCandidateSlot(state, candidate);
}

function appendFilePart(state: ExtractionState, part: FilePart): void {
	if (part.remoteUrl) {
		state.error = unsupportedImageInput(
			"remote image/file URLs are not supported in image generation mode",
		);
		return;
	}
	const upload = part.upload;
	const hasInline = !!upload && upload.b64 != null;
	if (part.fileRef && !hasInline) {
		state.slots.push({ type: "existing", ref: part.fileRef });
		return;
	}
	if (!upload || upload.b64 == null) {
		state.error = unsupportedImageInput(
			"image generation file input must be an inline payload or existing file reference",
		);
		return;
	}
	let bytes: Uint8Array;
	try {
		bytes = base64ToBytes(upload.b64);
	} catch (_) {
		state.error = unsupportedImageInput("invalid file base64 payload");
		return;
	}
	const detected = detectUploadMimeFromBytes(bytes);
	if (!normalizeMimeType(detected).startsWith("image/")) {
		state.error = unsupportedImageInput(
			"image generation file input bytes are not a supported image",
		);
		return;
	}
	const mime = firstNonEmptyString(detected, upload.mime, "image/png");
	const candidate: AttachmentCandidate = {
		id: `att_${state.nextID}`,
		kind: "image",
		role: "request",
		source: { type: "bytes", bytes },
	};
	const filename = firstNonEmptyString(
		upload.filename,
		part.filename,
		imageFilenameFromMime(mime, state.nextID),
	);
	if (filename) candidate.filename = filename;
	if (mime) candidate.mime = mime;
	addCandidateSlot(state, candidate);
}

function addCandidateSlot(
	state: ExtractionState,
	candidate: AttachmentCandidate,
): void {
	if (state.candidates.length >= MAX_ATTACHMENTS_PER_REQUEST) {
		state.error = {
			message: `image generation supports at most ${MAX_ATTACHMENTS_PER_REQUEST} user attachments`,
			status: 400,
			code: "image_input_unsupported",
		};
		return;
	}
	const index = state.candidates.length;
	state.candidates.push(candidate);
	state.slots.push({ type: "candidate", index });
	state.nextID += 1;
}

function unsupportedImageInput(message: string): ImageGenerationPrepareError {
	return { message, status: 400, code: "image_input_unsupported" };
}
