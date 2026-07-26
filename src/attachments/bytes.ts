import { TEXT_DECODER, UTF8_FATAL_DECODER } from "../shared/encoding";
import { isRecord } from "../shared/types";
import { firstNonEmptyString } from "../shared/strings";

// --- Base64 encoding ---

export function base64DecodedByteLength(raw: string): number {
	const compact = String(raw || "").replace(/\s+/g, "");
	if (!compact) return 0;
	return Math.floor((compact.replace(/=+$/, "").length * 3) / 4);
}

function validateBase64Shape(raw: unknown): string {
	const compact = String(raw || "").replace(/\s+/g, "");
	if (
		compact &&
		(!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact) ||
			compact.length % 4 === 1 ||
			/=(?=.*[^=])/.test(compact))
	)
		throw new Error("invalid base64 payload");
	return compact;
}

export function base64ToBytes(value: unknown): Uint8Array {
	const source = String(value || "");
	const nativeFromBase64 = (Uint8Array as Uint8ArrayBase64Constructor)
		.fromBase64;
	if (typeof nativeFromBase64 === "function") {
		try {
			return nativeFromBase64(
				source,
				/[-_]/.test(source) ? { alphabet: "base64url" } : undefined,
			);
		} catch (_) {
			throw new Error("invalid base64 payload");
		}
	}
	const compact = validateBase64Shape(source);
	const standard = /[-_]/.test(compact)
		? compact.replace(/-/g, "+").replace(/_/g, "/")
		: compact;
	const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
	const nativeToBase64 = (bytes as Uint8ArrayBase64).toBase64;
	if (typeof nativeToBase64 === "function") return nativeToBase64.call(bytes);
	let binary = "";
	for (let offset = 0; offset < bytes.byteLength; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

type Uint8ArrayBase64Alphabet = "base64" | "base64url";
type Uint8ArrayBase64Constructor = typeof Uint8Array & {
	fromBase64?: (
		value: string,
		options?: { alphabet?: Uint8ArrayBase64Alphabet },
	) => Uint8Array;
};
type Uint8ArrayBase64 = Uint8Array & {
	toBase64?: (options?: {
		alphabet?: Uint8ArrayBase64Alphabet;
		omitPadding?: boolean;
	}) => string;
};

// --- MIME / filename helpers ---

const MIME_MAX_LENGTH = 180;

export function sanitizeUploadFilename(name: unknown): string {
	if (typeof name !== "string" && typeof name !== "number") return "";
	let safeName = String(name || "").trim();
	if (!safeName) return "";
	safeName = safeName
		.replace(/\0/g, "")
		.replace(/[\r\n\t]/g, " ")
		.trim();
	safeName = safeName.split(/[\\/]/).filter(Boolean).pop() || "";
	safeName = safeName.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	if (!safeName || safeName === "." || safeName === "..") return "";
	return safeName.slice(0, 180);
}

export function mimeFromFilename(name: unknown): string {
	const safeName = sanitizeUploadFilename(name).toLowerCase();
	const extension = safeName.includes(".")
		? safeName.split(".").pop() || ""
		: "";
	const types: Record<string, string> = {
		txt: "text/plain",
		log: "text/plain",
		md: "text/markdown",
		markdown: "text/markdown",
		csv: "text/csv",
		json: "application/json",
		jsonl: "application/x-ndjson",
		js: "text/javascript",
		mjs: "text/javascript",
		cjs: "text/javascript",
		ts: "text/typescript",
		tsx: "text/typescript",
		py: "text/x-python",
		html: "text/html",
		htm: "text/html",
		css: "text/css",
		xml: "application/xml",
		pdf: "application/pdf",
	};
	return types[extension] || "";
}

export function genericFilenameFromMime(mime: unknown, index: number): string {
	const base = `file-${Math.max(1, Math.floor(index) || 1)}`;
	const type = normalizeMimeType(mime);
	const extensions: Record<string, string> = {
		"text/markdown": "md",
		"text/csv": "csv",
		"application/json": "json",
		"application/x-ndjson": "jsonl",
		"text/javascript": "js",
		"application/javascript": "js",
		"text/typescript": "ts",
		"text/x-python": "py",
		"text/html": "html",
		"text/css": "css",
		"application/xml": "xml",
		"text/xml": "xml",
		"application/pdf": "pdf",
		"text/plain": "txt",
	};
	return `${base}.${extensions[type] || (type.startsWith("text/") ? "txt" : "bin")}`;
}

export function imageFilenameFromMime(mime: unknown, index: number): string {
	const base = `image${index > 1 ? `-${index}` : ""}`;
	const extensions: Record<string, string> = {
		"image/jpeg": "jpg",
		"image/jpg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif",
		"image/bmp": "bmp",
		"image/heic": "heic",
		"image/heif": "heif",
	};
	return `${base}.${extensions[normalizeMimeType(mime)] || "png"}`;
}

export function cleanUploadMime(value: unknown): string {
	if (typeof value !== "string" && typeof value !== "number") return "";
	return String(value || "")
		.replace(/[\r\n]/g, "")
		.trim()
		.slice(0, MIME_MAX_LENGTH);
}

export function chooseUploadMime(...values: unknown[]): string {
	for (const value of values) {
		const mime = cleanUploadMime(value);
		if (mime) return mime;
	}
	return "application/octet-stream";
}

export function normalizeMimeType(value: unknown): string {
	return (String(value || "").split(";")[0] || "").trim().toLowerCase();
}

export function detectUploadMimeFromBytes(bytes: Uint8Array): string {
	if (!bytes?.byteLength) return "";
	if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return "image/png";
	if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a"))
		return "image/gif";
	if (startsWithAscii(bytes, "RIFF") && asciiAt(bytes, 8, "WEBP"))
		return "image/webp";
	if (startsWithAscii(bytes, "%PDF-")) return "application/pdf";
	if (startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]))
		return "application/zip";
	if (!looksLikeUtf8Text(bytes)) return "";
	const text = TEXT_DECODER.decode(
		bytes.slice(0, Math.min(bytes.byteLength, 4096)),
	).trimStart();
	return text.startsWith("{") || text.startsWith("[")
		? "application/json"
		: "text/plain";
}

function startsWithBytes(
	bytes: Uint8Array,
	prefix: readonly number[],
): boolean {
	return (
		bytes.byteLength >= prefix.length &&
		prefix.every((value, index) => bytes[index] === value)
	);
}
function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
	return asciiAt(bytes, 0, prefix);
}
function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
	if (bytes.byteLength < offset + text.length) return false;
	for (let index = 0; index < text.length; index++)
		if (bytes[offset + index] !== text.charCodeAt(index)) return false;
	return true;
}
function looksLikeUtf8Text(bytes: Uint8Array): boolean {
	const sample = bytes.slice(0, Math.min(bytes.byteLength, 4096));
	for (const byte of sample)
		if (byte === 0 || byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
	try {
		UTF8_FATAL_DECODER.decode(sample);
		return true;
	} catch (_) {
		return false;
	}
}

// --- Filename metadata extraction ---

export function uploadFilenameFromObject(obj: unknown): string {
	if (!isRecord(obj)) return "";
	const record = obj;
	const source = isRecord(record.source) ? record.source : null;
	const imageUrl = isRecord(record.image_url) ? record.image_url : null;
	const inlineData = isRecord(record.inlineData)
		? record.inlineData
		: isRecord(record.inline_data)
			? record.inline_data
			: null;
	const fileData = isRecord(record.fileData)
		? record.fileData
		: isRecord(record.file_data)
			? record.file_data
			: null;
	const file = isRecord(record.file) ? record.file : null;
	return firstNonEmptyString(
		...[
			record.filename,
			record.fileName,
			record.file_name,
			record.name,
			record.displayName,
			record.display_name,
			source &&
				(source.filename ||
					source.fileName ||
					source.file_name ||
					source.name ||
					source.displayName ||
					source.display_name),
			imageUrl &&
				(imageUrl.filename ||
					imageUrl.fileName ||
					imageUrl.file_name ||
					imageUrl.name ||
					imageUrl.displayName ||
					imageUrl.display_name),
			inlineData &&
				(inlineData.filename ||
					inlineData.fileName ||
					inlineData.file_name ||
					inlineData.name ||
					inlineData.displayName ||
					inlineData.display_name),
			fileData &&
				(fileData.filename ||
					fileData.fileName ||
					fileData.file_name ||
					fileData.name ||
					fileData.displayName ||
					fileData.display_name),
			file &&
				(file.filename ||
					file.fileName ||
					file.file_name ||
					file.name ||
					file.displayName ||
					file.display_name),
		].map(sanitizeUploadFilename),
	);
}
