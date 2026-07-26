import { TEXT_ENCODER } from "../shared/encoding";
import { firstNonEmptyString } from "../shared/strings";
import {
	firstNonNil,
	firstRecord,
	isRecord,
	type UnknownRecord,
} from "../shared/types";
import {
	bytesToBase64,
	cleanUploadMime,
	genericFilenameFromMime,
	imageFilenameFromMime,
	mimeFromFilename,
	sanitizeUploadFilename,
	uploadFilenameFromObject,
} from "./bytes";
import type {
	AttachmentCandidate,
	AttachmentDrop,
	AttachmentFileRef,
	AttachmentKind,
	AttachmentPlan,
} from "./types";

export { uploadFilenameFromObject } from "./bytes";

// --- Drop notes ---

export function droppedAttachmentNote(
	drops: readonly AttachmentDrop[] | null | undefined,
): string {
	if (!drops?.length) return "";
	const groups = new Map<
		string,
		{ kind: AttachmentKind; message: string; count: number }
	>();
	for (const drop of drops) {
		const key = `${drop.kind}\x00${drop.message}`;
		const existing = groups.get(key);
		if (existing) existing.count += 1;
		else groups.set(key, { kind: drop.kind, message: drop.message, count: 1 });
	}
	return [...groups.values()]
		.map(
			(group) =>
				`\n\n[Note: ${group.count} ${group.kind}(s) were provided but ignored - ${group.message}.]`,
		)
		.join("");
}

export function attachmentDrop(
	kind: AttachmentKind,
	code: AttachmentDrop["code"],
	message?: string,
	filename?: unknown,
): AttachmentDrop {
	const drop: AttachmentDrop = {
		kind,
		code,
		message: message || defaultDropMessage(code),
	};
	const safeName = sanitizeUploadFilename(filename);
	if (safeName) drop.filename = safeName;
	return drop;
}

function defaultDropMessage(code: AttachmentDrop["code"]): string {
	switch (code) {
		case "invalid_image_input":
			return "invalid image input";
		case "invalid_file_input":
			return "invalid file input";
		case "invalid_base64":
			return "invalid base64 payload";
		case "invalid_remote_url":
			return "invalid remote URL";
		case "file_too_large":
			return "file attachment is too large";
		case "image_too_large":
			return "image attachment is too large";
		case "too_many_files":
			return "too many attachments";
		case "upload_failed":
			return "attachment upload failed";
	}
}

// --- Existing file refs ---

type ExistingRefState = {
	out: AttachmentFileRef[];
	seen: Set<string>;
};

export function appendExistingFileRefs(
	out: AttachmentFileRef[],
	refs: unknown,
): void {
	const state: ExistingRefState = {
		out,
		seen: new Set(
			out
				.map((ref) => recognizedFileRefKey(ref))
				.filter((key): key is string => !!key),
		),
	};
	appendRefs(state, refs);
}

export function existingFileRefFromRecord(
	raw: unknown,
	includeDirectID: boolean,
): AttachmentFileRef | null {
	if (!isRecord(raw)) return null;
	let source = raw;
	let id = recognizedFileRefID(raw, includeDirectID);
	if (!id && isRecord(raw.file)) {
		source = raw.file;
		id = recognizedFileRefID(source, true);
	}
	if (!id) return null;
	const name =
		uploadFilenameFromObject(source) || uploadFilenameFromObject(raw);
	return name ? { id, name } : id;
}

export function recognizedFileRefID(
	raw: unknown,
	includeDirectID = true,
): string | null {
	if (typeof raw === "string") return normalizedRefID(raw);
	if (!isRecord(raw)) return null;
	const value =
		raw.file_id ??
		raw.fileId ??
		raw.file_ref ??
		raw.fileRef ??
		raw.ref ??
		(includeDirectID ? raw.id : null);
	return normalizedRefID(value);
}

export function recognizedFileRefKey(raw: unknown): string | null {
	return recognizedFileRefID(raw, true);
}

function appendRefs(state: ExistingRefState, raw: unknown): void {
	if (raw == null) return;
	if (typeof raw === "string") {
		addRef(state, raw);
		return;
	}
	if (Array.isArray(raw)) {
		for (const item of raw) appendRefs(state, item);
		return;
	}
	if (!isRecord(raw)) return;
	const ref = existingFileRefFromRecord(raw, true);
	if (ref) addRefValue(state, ref);
}

function addRefValue(state: ExistingRefState, ref: AttachmentFileRef): void {
	if (typeof ref === "string") {
		addRef(state, ref);
		return;
	}
	addRef(state, recognizedFileRefKey(ref), ref.name ?? ref.filename);
}

function addRef(
	state: ExistingRefState,
	fileID: unknown,
	filename: unknown = undefined,
): void {
	const id = normalizedRefID(fileID);
	if (!id || state.seen.has(id)) return;
	state.seen.add(id);
	const name = typeof filename === "string" ? filename.trim() : "";
	state.out.push(name ? { id, name } : id);
}

function normalizedRefID(value: unknown): string | null {
	const id = String(value ?? "").trim();
	return id || null;
}

// --- Upload input normalization ---

export type ParsedUploadUrl = { b64: string; mime: string };
export type UploadFileInput = {
	b64?: unknown;
	mime?: unknown;
	filename?: unknown;
	name?: unknown;
	invalidReason?: string;
};

function parseUploadUrl(url: unknown): ParsedUploadUrl | null {
	if (!url || typeof url !== "string") return null;
	const trimmed = url.trim();
	if (!isDataUrl(trimmed)) return null;
	const comma = trimmed.indexOf(",");
	if (comma < 0) return null;
	const header = trimmed.slice(0, comma);
	const payload = trimmed.slice(comma + 1);
	const meta = header.slice(5);
	const mime = cleanUploadMime((meta.split(";")[0] || "").toLowerCase());
	if (/;base64(?:;|$)/i.test(meta)) return { b64: payload, mime };
	try {
		return {
			b64: bytesToBase64(TEXT_ENCODER.encode(decodeURIComponent(payload))),
			mime,
		};
	} catch (_) {
		return null;
	}
}

export function parseImageUrl(
	url: unknown,
	explicitMime?: unknown,
): ParsedUploadUrl | null {
	const parsed = parseUploadUrl(url);
	if (!parsed) return null;
	return {
		...parsed,
		mime: firstNonEmptyString(
			cleanUploadMime(explicitMime),
			parsed.mime,
			"image/png",
		),
	};
}

export function uploadMimeFromObject(obj: unknown): string {
	if (!isRecord(obj)) return "";
	const record = obj;
	const source = isRecord(record.source) ? record.source : null;
	const imageUrl = isRecord(record.image_url) ? record.image_url : null;
	const inlineData =
		asOptionalRecord(record.inlineData) || asOptionalRecord(record.inline_data);
	const fileData =
		asOptionalRecord(record.fileData) || asOptionalRecord(record.file_data);
	const file = isRecord(record.file) ? record.file : null;
	return firstNonEmptyString(
		record.mime,
		record.mime_type,
		record.mimeType,
		record.media_type,
		record.mediaType,
		record.content_type,
		record.contentType,
		source &&
			(source.mime ||
				source.mime_type ||
				source.mimeType ||
				source.media_type ||
				source.mediaType ||
				source.content_type ||
				source.contentType),
		imageUrl &&
			(imageUrl.mime ||
				imageUrl.mime_type ||
				imageUrl.mimeType ||
				imageUrl.content_type ||
				imageUrl.contentType),
		inlineData &&
			(inlineData.mime ||
				inlineData.mime_type ||
				inlineData.mimeType ||
				inlineData.media_type ||
				inlineData.mediaType ||
				inlineData.content_type ||
				inlineData.contentType),
		fileData &&
			(fileData.mime ||
				fileData.mime_type ||
				fileData.mimeType ||
				fileData.media_type ||
				fileData.mediaType ||
				fileData.content_type ||
				fileData.contentType),
		file &&
			(file.mime ||
				file.mime_type ||
				file.mimeType ||
				file.media_type ||
				file.mediaType ||
				file.content_type ||
				file.contentType),
	);
}

export function normalizeUploadFileInput(
	file: unknown,
): UploadFileInput | null {
	if (typeof file === "string") {
		const parsed = parseUploadUrl(file);
		if (!parsed) return null;
		return { b64: parsed.b64, mime: parsed.mime || "application/octet-stream" };
	}
	if (!isRecord(file)) return null;
	const source = isRecord(file.source) ? file.source : null;
	const nestedFile = isRecord(file.file) ? file.file : null;
	const fileData = firstRecord(file.fileData, file.file_data);
	const filename = uploadFilenameFromObject(file);
	const explicitMime = uploadMimeFromObject(file);
	const urlValue = firstNonEmptyString(
		file.url,
		file.file_url,
		file.fileUrl,
		source?.url,
		nestedFile && (nestedFile.url || nestedFile.file_url || nestedFile.fileUrl),
		fileData?.url,
	);
	const dataValue = firstNonNil(
		fileData &&
			(fileData.data ??
				fileData.b64 ??
				fileData.base64 ??
				fileData.fileData ??
				fileData.file_data),
		file.file_data,
		file.fileData,
		file.data,
		file.b64,
		file.base64,
		source && (source.data ?? source.b64 ?? source.base64),
		nestedFile && (nestedFile.data ?? nestedFile.b64 ?? nestedFile.base64),
	);
	const parsedUrl = parseUploadUrl(urlValue);
	if (parsedUrl)
		return uploadInputFromParsed(parsedUrl, explicitMime, filename);
	const parsedData = parseUploadUrl(dataValue);
	if (parsedData)
		return uploadInputFromParsed(parsedData, explicitMime, filename);
	if (dataValue != null && typeof dataValue !== "object") {
		const out: UploadFileInput = { b64: dataValue };
		const mime = firstNonEmptyString(explicitMime, mimeFromFilename(filename));
		if (mime) out.mime = mime;
		if (filename) out.filename = filename;
		return out;
	}
	if (
		isExplicitUploadFileInput(file) &&
		!hasExistingUploadFileReference(file) &&
		!(fileData && (fileData.fileUri || fileData.file_uri))
	) {
		const out: UploadFileInput = {
			invalidReason: "missing generic file upload data",
		};
		const mime = firstNonEmptyString(explicitMime, mimeFromFilename(filename));
		if (mime) out.mime = mime;
		if (filename) out.filename = filename;
		return out;
	}
	return null;
}

function isDataUrl(raw: string): boolean {
	return /^data:/i.test(raw.trim());
}

function uploadInputFromParsed(
	parsed: ParsedUploadUrl,
	explicitMime: string,
	filename: string,
): UploadFileInput {
	const out: UploadFileInput = {
		b64: parsed.b64,
		mime:
			firstNonEmptyString(
				explicitMime,
				parsed.mime,
				mimeFromFilename(filename),
			) || "application/octet-stream",
	};
	if (filename) out.filename = filename;
	return out;
}

function isExplicitUploadFileInput(file: UnknownRecord): boolean {
	const typ = String(file.type || "")
		.trim()
		.toLowerCase();
	return typ === "input_file" || typ === "file";
}

function hasExistingUploadFileReference(file: UnknownRecord): boolean {
	if (recognizedFileRefID(file, true)) return true;
	const nestedFile = isRecord(file.file) ? file.file : null;
	return !!nestedFile && !!recognizedFileRefID(nestedFile, true);
}

function asOptionalRecord(value: unknown): UnknownRecord | null {
	return isRecord(value) ? value : null;
}

// --- Attachment plan ---

export const MAX_ATTACHMENTS_PER_REQUEST = 50;

type PlanState = {
	candidates: AttachmentCandidate[];
	existingFileRefs: AttachmentFileRef[];
	dropped: AttachmentDrop[];
	maxFiles: number;
	nextID: number;
};

type CreatePlanInput = {
	images?: unknown;
	files?: unknown;
	existingFileRefs?: unknown;
	maxFiles?: number;
};

export function createAttachmentPlan(
	input: CreatePlanInput = {},
): AttachmentPlan {
	const state: PlanState = {
		candidates: [],
		existingFileRefs: [],
		dropped: [],
		maxFiles: normalizeMaxFiles(input.maxFiles),
		nextID: 1,
	};
	appendExistingFileRefs(state.existingFileRefs, input.existingFileRefs);
	appendImageInputs(state, input.images);
	appendFileInputs(state, input.files);
	return finishPlan(state);
}

export function mergeAttachmentPlans(
	...plans: Array<AttachmentPlan | null | undefined>
): AttachmentPlan {
	const state: PlanState = {
		candidates: [],
		existingFileRefs: [],
		dropped: [],
		maxFiles: MAX_ATTACHMENTS_PER_REQUEST,
		nextID: 1,
	};
	for (const plan of plans) {
		if (!plan) continue;
		state.maxFiles = Math.min(state.maxFiles, normalizeMaxFiles(plan.maxFiles));
		appendExistingFileRefs(state.existingFileRefs, plan.existingFileRefs);
		for (const candidate of plan.candidates) {
			const meta: { filename?: string; mime?: string } = {};
			if (candidate.filename) meta.filename = candidate.filename;
			if (candidate.mime) meta.mime = candidate.mime;
			addCandidate(state, candidate.kind, candidate.source, meta);
		}
		state.dropped.push(...plan.dropped);
	}
	return finishPlan(state);
}

function appendImageInputs(state: PlanState, raw: unknown): void {
	if (!Array.isArray(raw)) return;
	for (let i = 0; i < raw.length; i++) {
		const image = raw[i];
		if (!isRecord(image)) continue;
		const b64 = image.b64;
		if (b64 == null) {
			state.dropped.push(
				attachmentDrop(
					"image",
					"invalid_image_input",
					"invalid image input",
					uploadFilenameFromObject(image),
				),
			);
			continue;
		}
		const name =
			firstNonEmptyString(
				sanitizeUploadFilename(image.filename),
				sanitizeUploadFilename(image.name),
			) ||
			imageFilenameFromMime(
				image.mime || "image/png",
				state.candidates.length + 1,
			);
		const source = { type: "base64" as const, data: b64 };
		const mime = firstNonEmptyString(image.mime, "image/png");
		addCandidate(state, "image", source, {
			filename: name,
			mime,
		});
	}
}

function appendFileInputs(state: PlanState, raw: unknown): void {
	if (!Array.isArray(raw)) return;
	for (const item of raw) {
		const input = isNormalizedUploadFileInput(item)
			? item
			: normalizeUploadFileInput(item);
		if (!input) continue;
		appendUploadFileInput(state, input);
	}
}

function appendUploadFileInput(state: PlanState, input: UploadFileInput): void {
	const nameHint = firstNonEmptyString(
		sanitizeUploadFilename(input.filename),
		sanitizeUploadFilename(input.name),
	);
	const mime = firstNonEmptyString(input.mime, mimeFromFilename(nameHint));
	if (input.invalidReason) {
		state.dropped.push(
			attachmentDrop(
				"file",
				"invalid_file_input",
				String(input.invalidReason || "invalid file input"),
				nameHint,
			),
		);
		return;
	}
	if (input.b64 != null) {
		const meta: { filename?: string; mime?: string } = {};
		if (nameHint) meta.filename = nameHint;
		else if (mime)
			meta.filename = genericFilenameFromMime(
				mime,
				state.candidates.length + 1,
			);
		if (mime) meta.mime = mime;
		addCandidate(
			state,
			"file",
			{ type: "base64", data: input.b64 },
			{
				...meta,
			},
		);
	}
}

function addCandidate(
	state: PlanState,
	kind: AttachmentKind,
	source: AttachmentCandidate["source"],
	meta: { filename?: string; mime?: string } = {},
): void {
	if (state.candidates.length >= state.maxFiles) {
		state.dropped.push(
			attachmentDrop(
				kind,
				"too_many_files",
				`exceeded maximum of ${state.maxFiles} attachments per request`,
				meta.filename,
			),
		);
		return;
	}
	const candidate: AttachmentCandidate = {
		id: `att_${state.nextID++}`,
		kind,
		role: "request",
		source,
	};
	const filename = sanitizeUploadFilename(meta.filename);
	if (filename) candidate.filename = filename;
	const mime = firstNonEmptyString(meta.mime);
	if (mime) candidate.mime = mime;
	state.candidates.push(candidate);
}

function finishPlan(state: PlanState): AttachmentPlan {
	return {
		candidates: state.candidates,
		existingFileRefs: state.existingFileRefs.length
			? state.existingFileRefs
			: null,
		dropped: state.dropped,
		maxFiles: state.maxFiles,
	};
}

function normalizeMaxFiles(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return MAX_ATTACHMENTS_PER_REQUEST;
	return Math.max(1, Math.floor(n));
}

function isNormalizedUploadFileInput(value: unknown): value is UploadFileInput {
	if (!isRecord(value)) return false;
	return "invalidReason" in value || "b64" in value;
}
