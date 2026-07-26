import { randHex } from "../shared/crypto";
import { isRecord, type UnknownRecord } from "../shared/types";
import { createToolBundle, type ToolBundle } from "./tool-bundle";

// --- xml ---

type XmlTagInfo = {
	name: string;
	closing: boolean;
	selfClosing: boolean;
	start: number;
	end: number;
	attrs: string;
};

export type XmlElementBlock = {
	name: string;
	attrs: string;
	body: string;
	start: number;
	end: number;
};

const XML_TAG_NAME_RE = /[A-Za-z_][A-Za-z0-9_:-]*/y;

export function decodeCDATA(text: unknown): string {
	const raw = String(text || "");
	const closed = raw.replace(
		/<!\[CDATA\[([\s\S]*?)]]>/g,
		(_m, body: string) => body,
	);
	if (closed !== raw) return closed;
	if (raw.startsWith("<![CDATA[")) return raw.slice("<![CDATA[".length);
	return raw;
}

export function decodeXmlEntities(text: unknown): string {
	return String(text || "")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export function appendMarkupValue(
	obj: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	if (Object.hasOwn(obj, key)) {
		if (Array.isArray(obj[key])) obj[key].push(value);
		else obj[key] = [obj[key], value];
	} else {
		obj[key] = value;
	}
}

export function parseTagAttributes(attrs: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /\b([a-z0-9_:-]+)\s*=\s*("([^"]*)"|'([^']*)')/gi;
	const source = String(attrs || "");
	let m: RegExpExecArray | null = re.exec(source);
	while (m !== null) {
		const key = m[1];
		if (key) out[key] = decodeXmlEntities(m[3] != null ? m[3] : m[4] || "");
		m = re.exec(source);
	}
	const bare = /\b([a-z0-9_:-]+)\s*=\s*([^\s"'=<>`]+)/gi;
	m = bare.exec(source);
	while (m !== null) {
		const key = m[1];
		if (key && !(key in out)) out[key] = decodeXmlEntities(m[2] || "");
		m = bare.exec(source);
	}
	return out;
}

export function findXmlElementBlocks(
	text: unknown,
	tag: unknown,
): XmlElementBlock[] {
	const source = String(text || "");
	const name = String(tag || "").toLowerCase();
	const out: XmlElementBlock[] = [];
	let pos = 0;
	while (pos < source.length) {
		const start = findNextXmlTag(source, name, pos, false);
		if (!start) break;
		let depth = 1;
		let seek = start.end + 1;
		let end: XmlTagInfo | null = null;
		while (seek < source.length) {
			const next = findNextXmlTag(source, name, seek, null);
			if (!next) break;
			if (next.selfClosing) {
				seek = next.end + 1;
				continue;
			}
			if (next.closing) depth -= 1;
			else depth += 1;
			if (depth === 0) {
				end = next;
				break;
			}
			seek = next.end + 1;
		}
		if (!end) {
			pos = start.end + 1;
			continue;
		}
		out.push({
			name,
			attrs: start.attrs,
			body: source.slice(start.end + 1, end.start),
			start: start.start,
			end: end.end + 1,
		});
		pos = end.end + 1;
	}
	return out;
}

export function findTopLevelXmlElementBlocks(text: unknown): XmlElementBlock[] {
	const source = String(text || "");
	const out: XmlElementBlock[] = [];
	let pos = 0;
	while (pos < source.length) {
		const start = findNextAnyXmlTag(source, pos, false);
		if (!start) break;
		if (start.start > pos && source.slice(pos, start.start).trim()) break;
		if (start.selfClosing) {
			out.push({
				name: start.name,
				attrs: start.attrs,
				body: "",
				start: start.start,
				end: start.end + 1,
			});
			pos = start.end + 1;
			continue;
		}
		let depth = 1;
		let seek = start.end + 1;
		let end: XmlTagInfo | null = null;
		while (seek < source.length) {
			const next = findNextXmlTag(source, start.name, seek, null);
			if (!next) break;
			if (next.selfClosing) {
				seek = next.end + 1;
				continue;
			}
			if (next.closing) depth -= 1;
			else depth += 1;
			if (depth === 0) {
				end = next;
				break;
			}
			seek = next.end + 1;
		}
		if (!end) break;
		out.push({
			name: start.name,
			attrs: start.attrs,
			body: source.slice(start.end + 1, end.start),
			start: start.start,
			end: end.end + 1,
		});
		pos = end.end + 1;
	}
	if (pos < source.length && source.slice(pos).trim()) return [];
	return out;
}

function findNextXmlTag(
	text: string,
	tag: unknown,
	from: number,
	closing: boolean | null,
): XmlTagInfo | null {
	const wanted = String(tag || "").toLowerCase();
	for (let i = Math.max(0, from || 0); i < text.length; ) {
		i = text.indexOf("<", i);
		if (i < 0) return null;
		const cdataEnd = skipCDATAAt(text, i);
		if (cdataEnd > i) {
			i = cdataEnd;
			continue;
		}
		const tagInfo = scanXmlTagAt(text, i);
		if (
			tagInfo &&
			tagInfo.name === wanted &&
			(closing === null || tagInfo.closing === closing)
		)
			return tagInfo;
		i += 1;
	}
	return null;
}

function findNextAnyXmlTag(
	text: string,
	from: number,
	closing: boolean | null,
): XmlTagInfo | null {
	for (let i = Math.max(0, from || 0); i < text.length; ) {
		i = text.indexOf("<", i);
		if (i < 0) return null;
		const cdataEnd = skipCDATAAt(text, i);
		if (cdataEnd > i) {
			i = cdataEnd;
			continue;
		}
		const tagInfo = scanXmlTagAt(text, i);
		if (tagInfo && (closing === null || tagInfo.closing === closing))
			return tagInfo;
		i += 1;
	}
	return null;
}

function skipCDATAAt(text: string, i: number): number {
	if (!text.startsWith("<![CDATA[", i)) return i;
	const end = text.indexOf("]]>", i + 9);
	return end < 0 ? i : end + 3;
}

function scanXmlTagAt(text: string, i: number): XmlTagInfo | null {
	if (text[i] !== "<") return null;
	let p = i + 1;
	let closing = false;
	if (text[p] === "/") {
		closing = true;
		p += 1;
	}
	XML_TAG_NAME_RE.lastIndex = p;
	const m = XML_TAG_NAME_RE.exec(text);
	if (!m) return null;
	const name = m[0].toLowerCase();
	p += m[0].length;
	const nextChar = text[p];
	if (p < text.length && (nextChar === undefined || !/[\s/>]/.test(nextChar)))
		return null;
	const end = findXmlTagEnd(text, p);
	if (end < 0) return null;
	const attrsEnd = text[end - 1] === "/" ? end - 1 : end;
	return {
		name,
		closing,
		selfClosing: !closing && text[end - 1] === "/",
		start: i,
		end,
		attrs: text.slice(p, attrsEnd),
	};
}

function findXmlTagEnd(text: string, from: number): number {
	let quote = "";
	for (let i = Math.max(0, from || 0); i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ">") return i;
	}
	return -1;
}

// --- markdown ---

type MarkdownFenceLine = {
	ch: string;
	len: number;
	index: number;
	canClose: boolean;
};
type MarkdownFenceState = { ch: string; len: number; index: number };
type MarkdownRange = { start: number; end: number };
type MaskedMarkdown = { text: string; restore: (value: unknown) => string };
export type MarkdownProtectionLookup = {
	isProtected: (index: number) => boolean;
};

const MARKDOWN_FENCE_LINE_RE = /^(\s*)(```+|~~~+)([^\r\n]*)$/;

export function createMarkdownProtectionLookup(
	text: unknown,
): MarkdownProtectionLookup {
	const ranges = markdownProtectedRanges(text);
	return {
		isProtected(index: number): boolean {
			return isIndexInRanges(ranges, Math.max(0, index));
		},
	};
}

export function markdownProtectedSpanStartAtCut(
	text: unknown,
	cut: number,
): number {
	const source = String(text || "");
	const pos = Math.max(0, Math.min(source.length, cut));
	if (pos <= 0 || pos >= source.length) return -1;
	const fenceStart = openMarkdownFenceStart(source.slice(0, pos));
	if (fenceStart >= 0) return fenceStart;
	return markdownCodeSpanStartAt(source, pos);
}

function markdownCodeSpanStartAt(text: unknown, index: number): number {
	const source = String(text || "");
	const pos = Math.max(0, Math.min(source.length, index));
	const lineStart =
		Math.max(
			source.lastIndexOf("\n", pos - 1),
			source.lastIndexOf("\r", pos - 1),
		) + 1;
	let openIndex = -1;
	let openLen = 0;
	for (let i = lineStart; i < pos; i++) {
		if (source[i] !== "`") continue;
		let j = i;
		while (j < source.length && source[j] === "`") j++;
		const len = j - i;
		if (len < 3) {
			if (openIndex >= 0 && len === openLen) {
				openIndex = -1;
				openLen = 0;
			} else if (openIndex < 0) {
				openIndex = i;
				openLen = len;
			}
		}
		i = j - 1;
	}
	return openIndex;
}

export function markdownProtectedTailStart(text: unknown): number {
	const source = String(text || "");
	if (!source) return -1;
	const fenceStart = openMarkdownFenceStart(source);
	if (fenceStart >= 0) return fenceStart;
	return openMarkdownCodeSpanStart(source);
}

function openMarkdownFenceStart(text: unknown): number {
	const source = String(text || "");
	const state: { fence: MarkdownFenceState | null } = { fence: null };
	forEachMarkdownLine(source, (line, lineStart) => {
		const parsed = parseMarkdownFenceLine(line);
		if (parsed) {
			const cur = {
				ch: parsed.ch,
				len: parsed.len,
				index: lineStart + parsed.index,
			};
			if (!state.fence) state.fence = cur;
			else if (
				parsed.canClose &&
				cur.ch === state.fence.ch &&
				cur.len >= state.fence.len
			)
				state.fence = null;
		}
	});
	return state.fence ? state.fence.index : -1;
}

export function parseMarkdownFenceLine(
	line: unknown,
): MarkdownFenceLine | null {
	const m = MARKDOWN_FENCE_LINE_RE.exec(String(line || ""));
	if (!m) return null;
	const mark = m[2] || "";
	if (!mark) return null;
	const rest = String(m[3] || "");
	const trimmed = rest.trim();
	if (mark[0] === "`" && rest.includes("`")) return null;
	if (trimmed && /[<>\]]/.test(trimmed)) return null;
	if (trimmed && !/^[A-Za-z0-9_.+#-]+(?:[ \t].*)?$/.test(trimmed)) return null;
	return {
		ch: mark[0] || "",
		len: mark.length,
		index: (m[1] || "").length,
		canClose: !trimmed,
	};
}

function openMarkdownCodeSpanStart(text: unknown): number {
	const source = String(text || "");
	const lineStart =
		Math.max(source.lastIndexOf("\n"), source.lastIndexOf("\r")) + 1;
	let openIndex = -1;
	let openLen = 0;
	for (let i = lineStart; i < source.length; i++) {
		if (source[i] !== "`") continue;
		let j = i;
		while (j < source.length && source[j] === "`") j++;
		const len = j - i;
		if (len < 3) {
			if (openIndex >= 0 && len === openLen) {
				openIndex = -1;
				openLen = 0;
			} else if (openIndex < 0) {
				openIndex = i;
				openLen = len;
			}
		}
		i = j - 1;
	}
	return openIndex;
}

function markdownProtectedRanges(text: unknown): MarkdownRange[] {
	const source = String(text || "");
	const ranges: MarkdownRange[] = [];
	const state: { fence: MarkdownFenceState | null } = { fence: null };
	forEachMarkdownLine(source, (line, lineStart, separatorLength) => {
		const parsed = parseMarkdownFenceLine(line);
		if (state.fence) {
			if (
				parsed?.canClose &&
				parsed.ch === state.fence.ch &&
				parsed.len >= state.fence.len
			) {
				ranges.push({
					start: state.fence.index,
					end: lineStart + line.length + separatorLength,
				});
				state.fence = null;
			}
		} else if (parsed) {
			const cur = {
				ch: parsed.ch,
				len: parsed.len,
				index: lineStart + parsed.index,
			};
			state.fence = cur;
		} else {
			appendInlineCodeSpanRanges(line, lineStart, ranges);
		}
	});
	if (state.fence)
		ranges.push({ start: state.fence.index, end: source.length });

	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: MarkdownRange[] = [];
	for (const r of ranges) {
		if (r.start < 0 || r.end <= r.start) continue;
		const last = merged[merged.length - 1];
		if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
		else merged.push({ start: r.start, end: r.end });
	}
	return merged;
}

function forEachMarkdownLine(
	source: string,
	visit: (line: string, lineStart: number, separatorLength: number) => void,
): void {
	let lineStart = 0;
	for (;;) {
		const newline = source.indexOf("\n", lineStart);
		if (newline < 0) {
			visit(source.slice(lineStart), lineStart, 0);
			return;
		}
		const hasCarriageReturn =
			newline > lineStart && source.charCodeAt(newline - 1) === 13;
		const lineEnd = hasCarriageReturn ? newline - 1 : newline;
		visit(
			source.slice(lineStart, lineEnd),
			lineStart,
			hasCarriageReturn ? 2 : 1,
		);
		lineStart = newline + 1;
	}
}

function appendInlineCodeSpanRanges(
	line: string,
	lineStart: number,
	ranges: MarkdownRange[],
): void {
	let openIndex = -1;
	let openLen = 0;
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "`") continue;
		let j = i;
		while (j < line.length && line[j] === "`") j++;
		const len = j - i;
		if (len < 3) {
			if (openIndex >= 0 && len === openLen) {
				ranges.push({ start: lineStart + openIndex, end: lineStart + j });
				openIndex = -1;
				openLen = 0;
			} else if (openIndex < 0) {
				openIndex = i;
				openLen = len;
			}
		}
		i = j - 1;
	}
	if (openIndex >= 0)
		ranges.push({ start: lineStart + openIndex, end: lineStart + line.length });
}

function isIndexInRanges(ranges: MarkdownRange[], index: number): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const range = ranges[mid];
		if (!range) return false;
		if (index < range.start) hi = mid - 1;
		else if (index >= range.end) lo = mid + 1;
		else return true;
	}
	return false;
}

export function maskMarkdownProtectedSpans(text: unknown): MaskedMarkdown {
	const source = String(text || "");
	const ranges = markdownProtectedRanges(source);
	const placeholders: [string, string][] = [];
	if (!ranges.length)
		return { text: source, restore: (value: unknown) => String(value || "") };
	let last = 0;
	let masked = "";
	for (let i = 0; i < ranges.length; i++) {
		const r = ranges[i];
		if (!r) continue;
		const token = `GEMINI_MD_PROTECTED_${i}_TOKEN`;
		placeholders.push([token, source.slice(r.start, r.end)]);
		masked += source.slice(last, r.start) + token;
		last = r.end;
	}
	masked += source.slice(last);
	const restoreByToken = new Map(placeholders);
	const restoreRe = new RegExp(
		placeholders.map(([token]) => escapeRegex(token)).join("|"),
		"g",
	);
	return {
		text: masked,
		restore(value: unknown) {
			return String(value || "").replace(
				restoreRe,
				(token) => restoreByToken.get(token) || token,
			);
		},
	};
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- syntax-probe ---

export const TOOL_MARKUP_CONFUSABLE_RE =
	/[※＜〈＞〉／＝＂“”＇‘’｜！\u3000ｄＤｓＳЅｍＭΜｌＬοоаｅΑАС\u200b\ufeff]/;

const TOOL_TAG_RE =
	/<\s*\/?\s*(?:\|?\s*D?SML\s*[|!、\u0002␂_\-\s▁]+|D?SML(?=tool_calls|tool-calls|toolcalls|invoke|parameter)|[\w$-]+[|!、\u0002␂_\-\s▁💥]+)?\s*(tool_calls|tool-calls|toolcalls|invoke|parameter)\b/giu;
const TOOL_CAMEL_TAG_RE =
	/<\s*\/?\s*[A-Za-z][A-Za-z0-9_$-]*(ToolCalls|Invoke|Parameter)\b/g;
const TOOL_TAG_SHELL_QUICK_AT_OPEN_RE =
	/<\s*\/?\s*(?:\|?\s*D?SML\s*(?:[|!、\u0002␂_\-\s▁]+|(?=tool_calls|tool-calls|toolcalls|invoke|parameter))|tool_calls\b|tool-calls\b|toolcalls\b|invoke\b|parameter\b|[A-Za-z][A-Za-z0-9_$-]*(?:ToolCalls|Invoke|Parameter)\b|[\w$-]+(?:[|!、\u0002␂_\-▁💥]+|\s+)\s*(?:tool_calls|tool-calls|toolcalls|invoke|parameter)\b)/iuy;
const TOOL_CALLS_CLOSE_RE =
	/<\s*\/\s*(?:\|?\s*D?SML\s*[|!、\u0002␂_\-\s▁]+)?\s*(tool_calls|tool-calls|toolcalls)\s*>/i;
const PARTIAL_TOOL_PREFIXES = [
	"<|dsml|tool_calls",
	"<|dsml|tool-calls",
	"<|dsml|toolcalls",
	"<|dsml|invoke",
	"<|dsml|parameter",
	"<dsmltool_calls",
	"<dsmltool-calls",
	"<dsmltoolcalls",
	"<dsmlinvoke",
	"<dsmlparameter",
	"<tool_calls",
	"<tool-calls",
	"<toolcalls",
	"<invoke",
	"<parameter",
];

export function containsToolMarkupSyntax(text: unknown): boolean {
	const source = normalizeToolMarkupConfusables(String(text || ""));
	if (!hasMarkupOpen(source)) return false;
	return hasToolTagShellAtMarkupOpen(source);
}

export function findToolCallSyntaxCandidateStart(
	text: unknown,
	ignoreMarkdown = true,
): number {
	const source = normalizeToolMarkupConfusables(String(text || ""));
	if (!hasMarkupOpen(source)) return -1;
	const markdown = ignoreMarkdown
		? createMarkdownProtectionLookup(source)
		: null;
	if (hasToolTagShellAtMarkupOpen(source)) {
		const fromTag = findRegexCandidateStart(source, TOOL_TAG_RE, markdown);
		if (fromTag >= 0) return fromTag;
		const fromCamel = findRegexCandidateStart(
			source,
			TOOL_CAMEL_TAG_RE,
			markdown,
		);
		if (fromCamel >= 0) return fromCamel;
	}
	return findLastPartialToolCallSyntaxPrefixInNormalizedSource(
		source,
		markdown,
	);
}

function findLastPartialToolCallSyntaxPrefix(
	text: unknown,
	ignoreMarkdown = true,
): number {
	const source = normalizeToolMarkupConfusables(String(text || ""));
	if (source.lastIndexOf("<") < 0) return -1;
	return findLastPartialToolCallSyntaxPrefixInNormalizedSource(
		source,
		ignoreMarkdown ? createMarkdownProtectionLookup(source) : null,
	);
}

function findLastPartialToolCallSyntaxPrefixInNormalizedSource(
	source: string,
	markdown: MarkdownProtectionLookup | null,
): number {
	const lastLt = source.lastIndexOf("<");
	if (lastLt < 0) return -1;
	if (markdown?.isProtected(lastLt)) return -1;
	return isPartialToolCallSyntaxPrefix(source.slice(lastLt)) ? lastLt : -1;
}

export function isPartialToolCallSyntaxPrefix(text: unknown): boolean {
	const compact = normalizeMarkupTagShell(String(text || ""))
		.replace(/[\s▁]+/g, "")
		.toLowerCase();
	if (compact?.[0] !== "<") return false;
	return PARTIAL_TOOL_PREFIXES.some(
		(candidate) =>
			candidate.startsWith(compact) || compact.startsWith(candidate),
	);
}

export function hasClosedToolCallsSyntax(text: unknown): boolean {
	const source = normalizeToolMarkupConfusables(String(text || ""));
	return TOOL_CALLS_CLOSE_RE.test(source);
}

export function toolCallSieveSafeTailLength(text: unknown): number {
	const source = String(text || "");
	const partial = findLastPartialToolCallSyntaxPrefix(source);
	if (partial < 0) return 64;
	return Math.max(64, source.length - partial);
}

export function normalizeToolMarkupConfusables(text: unknown): string {
	const source = String(text || "");
	if (!TOOL_MARKUP_CONFUSABLE_RE.test(source)) return source;
	return source
		.replace(/※\s*>/g, ">")
		.replace(/[＜〈]/g, "<")
		.replace(/[＞〉]/g, ">")
		.replace(/[／]/g, "/")
		.replace(/[＝]/g, "=")
		.replace(/[＂“”]/g, '"')
		.replace(/[＇‘’]/g, "'")
		.replace(/[｜]/g, "|")
		.replace(/[！]/g, "!")
		.replace(/[\u3000]/g, " ")
		.replace(/[ｄＤ]/g, "D")
		.replace(/[ｓＳЅ]/g, "S")
		.replace(/[ｍＭΜ]/g, "M")
		.replace(/[ｌＬ]/g, "L")
		.replace(/[οо]/g, "o")
		.replace(/[а]/g, "a")
		.replace(/[е]/g, "e")
		.replace(/[ΑА]/g, "A")
		.replace(/[С]/g, "C")
		.replace(/※/g, ">")
		.replace(/[\u200b\ufeff]/g, "");
}

function normalizeMarkupTagShell(tag: unknown): string {
	return normalizeToolMarkupConfusables(tag);
}

function findRegexCandidateStart(
	source: string,
	re: RegExp,
	markdown: MarkdownProtectionLookup | null,
): number {
	re.lastIndex = 0;
	let m: RegExpExecArray | null = re.exec(source);
	while (m !== null) {
		if (!markdown?.isProtected(m.index)) return m.index;
		re.lastIndex = m.index + Math.max(1, m[0].length);
		m = re.exec(source);
	}
	return -1;
}

function hasMarkupOpen(source: string): boolean {
	return (
		source.indexOf("<") >= 0 ||
		source.indexOf("＜") >= 0 ||
		source.indexOf("〈") >= 0
	);
}

function hasToolTagShellAtMarkupOpen(source: string): boolean {
	let index = source.indexOf("<");
	while (index >= 0) {
		TOOL_TAG_SHELL_QUICK_AT_OPEN_RE.lastIndex = index;
		if (TOOL_TAG_SHELL_QUICK_AT_OPEN_RE.test(source)) return true;
		index = source.indexOf("<", index + 1);
	}
	return false;
}

// --- schema-normalize ---

type SchemaNormalizedToolCall = UnknownRecord & {
	name?: unknown;
	input?: unknown;
};
type ArraySchemaRecord = UnknownRecord & { items?: unknown };

export function normalizeParsedToolCallsForSchemas(
	calls: SchemaNormalizedToolCall[],
	tools: ToolBundle | null | undefined,
): SchemaNormalizedToolCall[];
export function normalizeParsedToolCallsForSchemas(
	calls: unknown,
	tools: ToolBundle | null | undefined,
): unknown;
export function normalizeParsedToolCallsForSchemas(
	calls: unknown,
	tools: ToolBundle | null | undefined,
): unknown {
	if (!Array.isArray(calls) || !calls.length) return calls;
	const schemas = tools ? tools.schemaIndex : null;
	if (!schemas) return calls;
	let changedAny = false;
	const out = calls.map((call) => {
		if (!isRecord(call)) return call;
		const name = String(call.name || "")
			.trim()
			.toLowerCase();
		const schema = schemas[name];
		if (!schema || !isRecord(call.input)) return call;
		const [normalized, changed] = normalizeToolValueWithSchema(
			call.input,
			schema,
		);
		if (!changed || !isRecord(normalized)) return call;
		changedAny = true;
		return { ...call, input: normalized };
	});
	return changedAny ? out : calls;
}

function normalizeToolValueWithSchema(
	value: unknown,
	schema: unknown,
): [unknown, boolean] {
	if (value == null || !isRecord(schema)) return [value, false];
	if (shouldCoerceSchemaToString(schema)) return stringifySchemaValue(value);
	if (looksLikeObjectSchema(schema)) {
		if (!isRecord(value)) return [value, false];
		const properties = isRecord(schema.properties) ? schema.properties : null;
		const additional = schema.additionalProperties;
		let changed = false;
		const out: UnknownRecord = {};
		for (const [key, current] of Object.entries(value)) {
			let next = current;
			let fieldChanged = false;
			if (properties && Object.hasOwn(properties, key))
				[next, fieldChanged] = normalizeToolValueWithSchema(
					current,
					properties[key],
				);
			else if (additional != null)
				[next, fieldChanged] = normalizeToolValueWithSchema(
					current,
					additional,
				);
			out[key] = next;
			changed = changed || fieldChanged;
		}
		return changed ? [out, true] : [value, false];
	}
	if (looksLikeArraySchema(schema)) {
		const itemsSchema = schema.items;
		if (!Array.isArray(value) || !value.length || itemsSchema == null)
			return [value, false];
		let changed = false;
		const out = value.map((item, idx) => {
			const itemSchema = Array.isArray(itemsSchema)
				? itemsSchema[idx]
				: itemsSchema;
			if (itemSchema == null) return item;
			const [next, itemChanged] = normalizeToolValueWithSchema(
				item,
				itemSchema,
			);
			changed = changed || itemChanged;
			return next;
		});
		return changed ? [out, true] : [value, false];
	}
	return [value, false];
}

function shouldCoerceSchemaToString(schema: unknown): boolean {
	if (!isRecord(schema)) return false;
	if (typeof schema.const === "string") return true;
	if (
		Array.isArray(schema.enum) &&
		schema.enum.length &&
		schema.enum.every((item) => typeof item === "string")
	)
		return true;
	if (typeof schema.type === "string")
		return schema.type.trim().toLowerCase() === "string";
	if (Array.isArray(schema.type) && schema.type.length) {
		let hasString = false;
		for (const item of schema.type) {
			if (typeof item !== "string") return false;
			const typ = item.trim().toLowerCase();
			if (typ === "string") hasString = true;
			else if (typ !== "null") return false;
		}
		return hasString;
	}
	return false;
}

function looksLikeObjectSchema(schema: unknown): boolean {
	return (
		isRecord(schema) &&
		((typeof schema.type === "string" &&
			schema.type.trim().toLowerCase() === "object") ||
			isRecord(schema.properties) ||
			schema.additionalProperties != null)
	);
}

function looksLikeArraySchema(schema: unknown): schema is ArraySchemaRecord {
	return (
		isRecord(schema) &&
		((typeof schema.type === "string" &&
			schema.type.trim().toLowerCase() === "array") ||
			schema.items != null)
	);
}

function stringifySchemaValue(value: unknown): [unknown, boolean] {
	if (value == null || typeof value === "string") return [value, false];
	try {
		return [JSON.stringify(value), true];
	} catch (_) {
		return [value, false];
	}
}

// --- openai-format ---

type NormalizedToolCall = {
	name: unknown;
	input?: unknown;
};
export type OpenAIToolCall = {
	id: string;
	type: "function";
	function: { name: unknown; arguments: string };
};
export type OpenAIStreamToolCall = OpenAIToolCall & { index: number };

export function formatOpenAIToolCalls(
	calls: unknown,
	tools: ToolBundle | null | undefined,
): OpenAIToolCall[] {
	const normalized = normalizeParsedToolCallsForSchemas(calls, tools);
	if (!Array.isArray(normalized)) return [];
	return normalized
		.map((c: NormalizedToolCall, idx: number) => ({
			id: `call_${randHex(8)}`,
			type: "function" as const,
			function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
			index: idx,
		}))
		.map(({ index: _index, ...tc }) => tc);
}

export function formatOpenAIStreamToolCalls(
	calls: unknown,
	idStore: Map<number, string> | null | undefined,
	tools: ToolBundle | null | undefined,
): OpenAIStreamToolCall[] {
	const normalized = normalizeParsedToolCallsForSchemas(calls, tools);
	if (!Array.isArray(normalized) || !normalized.length) return [];
	return normalized.map((c: NormalizedToolCall, idx: number) => ({
		index: idx,
		id: ensureStreamToolCallID(idStore, idx),
		type: "function" as const,
		function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
	}));
}

function ensureStreamToolCallID(
	idStore: Map<number, string> | null | undefined,
	index: unknown,
): string {
	if (!(idStore instanceof Map)) return `call_${randHex(32)}`;
	const key = Number.isInteger(index) ? Number(index) : 0;
	const existing = idStore.get(key);
	if (existing) return existing;
	const next = `call_${randHex(32)}`;
	idStore.set(key, next);
	return next;
}

// --- dsml ---

export type ParsedToolCall = {
	name: string;
	input: unknown;
};

export type DSMLToolCallParseResult = {
	cleanText: string;
	calls: ParsedToolCall[];
	sawToolCallSyntax: boolean;
};

type MarkdownRestore = (value: unknown) => string;

export function parseToolCalls(
	text: unknown,
	toolsRaw?: unknown,
): [string, OpenAIToolCall[]] {
	if (!containsToolMarkupSyntax(text)) return [String(text || "").trim(), []];
	const parsed = parseDSMLToolCallsDetailed(text);
	if (parsed.calls.length) {
		return [
			parsed.cleanText,
			formatOpenAIToolCalls(parsed.calls, createToolBundle(toolsRaw)),
		];
	}
	return [String(text || "").trim(), []];
}

export function parseDSMLToolCallsDetailed(
	text: unknown,
): DSMLToolCallParseResult {
	const raw = String(text || "");
	if (!raw) return { cleanText: "", calls: [], sawToolCallSyntax: false };
	if (!containsToolMarkupSyntax(raw))
		return { cleanText: raw.trim(), calls: [], sawToolCallSyntax: false };
	if (
		containsToolMarkupSyntax(raw) &&
		findToolCallSyntaxCandidateStart(raw) < 0
	) {
		return { cleanText: raw.trim(), calls: [], sawToolCallSyntax: true };
	}
	const canonical = parseCanonicalDSMLToolCallsFast(raw);
	if (canonical) return canonical;
	if (shouldSkipToolCallParsingForCodeFenceExample(raw))
		return { cleanText: raw.trim(), calls: [], sawToolCallSyntax: true };
	const protectedMarkdown = maskMarkdownProtectedSpans(raw);
	let normalized = normalizeDSMLToolCallMarkup(protectedMarkdown.text).trim();
	let blocks = findXmlElementBlocks(normalized, "tool_calls");
	if (
		!blocks.length &&
		/<\s*(?:\|DSML\|)?invoke\b/i.test(normalized) &&
		/<\s*\/\s*(?:\|DSML\|)?tool_calls\s*>/i.test(normalized)
	) {
		normalized = `<tool_calls>${normalized}`;
		blocks = findXmlElementBlocks(normalized, "tool_calls");
	}
	const calls: ParsedToolCall[] = [];
	for (const block of blocks) {
		for (const invoke of findXmlElementBlocks(block.body, "invoke")) {
			const parsed = parseMarkupSingleToolCall(invoke);
			if (parsed) calls.push(parsed);
		}
	}
	if (!calls.length) {
		return {
			cleanText: raw.trim(),
			calls: [],
			sawToolCallSyntax: containsToolMarkupSyntax(raw),
		};
	}
	let clean = normalized;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (block) clean = clean.slice(0, block.start) + clean.slice(block.end);
	}
	return {
		cleanText: protectedMarkdown.restore(clean).trim(),
		calls: restoreToolCallProtectedMarkdown(calls, protectedMarkdown.restore),
		sawToolCallSyntax: true,
	};
}

function parseCanonicalDSMLToolCallsFast(
	text: unknown,
): DSMLToolCallParseResult | null {
	const source = String(text || "").trim();
	if (!source) return null;
	if (source.indexOf("`") >= 0 || TOOL_MARKUP_CONFUSABLE_RE.test(source))
		return null;
	if (
		/<\s*\/?\s*(?:\|?\s*D?SML|tool-calls|toolcalls|[A-Za-z][A-Za-z0-9_$-]*(?:ToolCalls|Invoke|Parameter))\b/.test(
			source,
		)
	) {
		return null;
	}
	if (!/^<tool_calls(?:\s[^>]*)?>/i.test(source)) return null;
	const blocks = findXmlElementBlocks(source, "tool_calls");
	if (!blocks.length) return null;

	let pos = 0;
	for (const block of blocks) {
		if (source.slice(pos, block.start).trim()) return null;
		pos = block.end;
	}
	if (source.slice(pos).trim()) return null;

	const calls: ParsedToolCall[] = [];
	for (const block of blocks) {
		for (const invoke of findXmlElementBlocks(block.body, "invoke")) {
			const parsed = parseMarkupSingleToolCall(invoke);
			if (parsed) calls.push(parsed);
		}
	}
	if (!calls.length) return null;
	return { cleanText: "", calls, sawToolCallSyntax: true };
}

function restoreToolCallProtectedMarkdown(
	calls: ParsedToolCall[],
	restore: MarkdownRestore,
): ParsedToolCall[] {
	if (!Array.isArray(calls) || typeof restore !== "function") return [];
	return calls.map((call) => {
		return {
			...call,
			input: restoreToolValueProtectedMarkdown(call.input, restore),
		};
	});
}

function restoreToolValueProtectedMarkdown(
	value: unknown,
	restore: MarkdownRestore,
): unknown {
	if (typeof value === "string") {
		const restored = restore(value);
		return restored === value ? value : unwrapToolArgumentMarkdown(restored);
	}
	if (Array.isArray(value))
		return value.map((item) =>
			restoreToolValueProtectedMarkdown(item, restore),
		);
	if (isRecord(value)) {
		const out: UnknownRecord = {};
		for (const [key, child] of Object.entries(value))
			out[key] = restoreToolValueProtectedMarkdown(child, restore);
		return out;
	}
	return value;
}

function unwrapToolArgumentMarkdown(value: unknown): string {
	const text = String(value || "");
	const trimmed = text.trim();
	const fence = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(
		trimmed,
	);
	if (fence) return fence[1] || "";
	const inline = /^`([^`\r\n]*)`$/.exec(trimmed);
	if (inline) return inline[1] || "";
	return text;
}

function stripFencedCodeBlocks(text: unknown): string {
	const lines = String(text || "").split("\n");
	const out: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;
	for (const line of lines) {
		const parsed = parseMarkdownFenceLine(line);
		if (!inFence) {
			if (parsed) {
				inFence = true;
				fenceChar = parsed.ch;
				fenceLen = parsed.len;
				continue;
			}
			out.push(line);
			continue;
		}
		if (parsed?.canClose && parsed.ch === fenceChar && parsed.len >= fenceLen) {
			inFence = false;
			fenceChar = "";
			fenceLen = 0;
		}
	}
	return out.join("\n");
}

function shouldSkipToolCallParsingForCodeFenceExample(text: unknown): boolean {
	if (!containsToolMarkupSyntax(text)) return false;
	return !containsToolMarkupSyntax(stripFencedCodeBlocks(text));
}

function normalizeDSMLToolCallMarkup(text: unknown): string {
	return normalizeToolMarkupConfusables(text)
		.replace(/<<+/g, "<")
		.replace(/<!\s*\[\s*CDATA\s*\[/gi, "<![CDATA[")
		.replace(/<\s*[!、]\s*\[\s*CDATA\s*\[/gi, "<![CDATA[")
		.replace(/\]\]\s*>/g, "]]>")
		.replace(
			/<\s*(\/?)\s*(?:(?:\|?\s*D?SML\s*[|!、\u0002␂_\-\s▁]+)+(?:D?SML\s*[|!、\u0002␂_\-\s▁]+)*|D?SML(?=tool_calls|tool-calls|toolcalls|invoke|parameter)|[\w$-]+[|!、\u0002␂_\-\s▁💥]+)?\s*(tool_calls|tool-calls|toolcalls|invoke|parameter)\b([^>]*)>/giu,
			(_m: string, close: string, name: string, rest: string) =>
				`<${close ? "/" : ""}${canonicalToolTagName(name)}${rest}>`,
		)
		.replace(
			/<\s*(\/?)\s*[A-Za-z][A-Za-z0-9_$-]*(ToolCalls|Invoke|Parameter)\b([^>]*)>/g,
			(_m: string, close: string, name: string, rest: string) =>
				`<${close ? "/" : ""}${canonicalToolTagName(name)}${rest}>`,
		)
		.replace(
			/<\s*(\/?)\s*(tool-calls|toolcalls)\b([^>]*)>/gi,
			(_m: string, close: string, _name: string, rest: string) =>
				`<${close ? "/" : ""}tool_calls${rest}>`,
		);
}

function canonicalToolTagName(name: unknown): string {
	const n = String(name || "").toLowerCase();
	return n === "tool-calls" || n === "toolcalls" ? "tool_calls" : n;
}

function parseMarkupSingleToolCall(
	block: XmlElementBlock,
): ParsedToolCall | null {
	const attrs = parseTagAttributes(block.attrs);
	const name = String(attrs.name || "").trim();
	if (!name) return null;
	const inner = String(block.body || "").trim();
	if (inner) {
		try {
			const decoded: unknown = JSON.parse(inner);
			if (isRecord(decoded)) {
				const input =
					decoded.input ??
					decoded.parameters ??
					decoded.arguments ??
					decoded.args;
				return { name, input: isRecord(input) ? input : {} };
			}
		} catch (_) {}
	}
	const input: UnknownRecord = {};
	for (const match of findXmlElementBlocks(inner, "parameter")) {
		const parameterAttrs = parseTagAttributes(match.attrs);
		const paramName = String(parameterAttrs.name || "").trim();
		if (!paramName) continue;
		appendMarkupValue(input, paramName, parseMarkupValue(match.body));
	}
	if (!Object.keys(input).length && inner.trim() !== "") return null;
	return { name, input };
}

function parseMarkupValue(body: unknown): unknown {
	const rawBody = String(body || "");
	const raw = rawBody.trim();
	if (!raw) return "";
	if (raw.startsWith("<![CDATA[")) return decodeCDATA(raw);
	const children = findTopLevelXmlElementBlocks(raw);
	if (children.length) {
		if (children.every((child) => child.name === "item"))
			return children.map((child) => parseMarkupValue(child.body));
		const obj: UnknownRecord = {};
		for (const child of children)
			appendMarkupValue(obj, child.name, parseMarkupValue(child.body));
		return obj;
	}
	const decoded = decodeCDATA(raw).trim();
	const decodedForMarkup = decoded.replace(/<br\s*\/?\s*>/gi, "\n").trim();
	const decodedChildren = findTopLevelXmlElementBlocks(decodedForMarkup);
	if (decodedChildren.length) {
		if (decodedChildren.every((child) => child.name === "item"))
			return decodedChildren.map((child) => parseMarkupValue(child.body));
		const obj: UnknownRecord = {};
		for (const child of decodedChildren)
			appendMarkupValue(obj, child.name, parseMarkupValue(child.body));
		return obj;
	}
	return parseScalarValue(decoded);
}

function parseScalarValue(text: unknown): unknown {
	const s = String(text || "").trim();
	if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
	if (/^null$/i.test(s)) return null;
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
		const n = Number(s);
		if (Number.isFinite(n)) return n;
	}
	if (
		(s.startsWith("{") && s.endsWith("}")) ||
		(s.startsWith("[") && s.endsWith("]"))
	) {
		try {
			return JSON.parse(s);
		} catch (_) {}
	}
	if (s.startsWith("{") && /}\s*,\s*{/.test(s) && s.endsWith("}")) {
		try {
			return JSON.parse(`[${s}]`);
		} catch (_) {}
	}
	return decodeXmlEntities(s);
}

// --- google ---

type GoogleParsedToolCall = { name?: unknown; input?: unknown };
export type GoogleFunctionCall = { name: unknown; args: unknown };

function normalizeGoogleParsedCalls(
	calls: GoogleParsedToolCall[],
	tools: ToolBundle | null | undefined,
): GoogleParsedToolCall[] {
	const normalized = normalizeParsedToolCallsForSchemas(calls, tools);
	return Array.isArray(normalized)
		? (normalized as GoogleParsedToolCall[])
		: calls;
}

function toGoogleFunctionCalls(
	calls: GoogleParsedToolCall[],
): GoogleFunctionCall[] {
	return calls.map((call) => ({ name: call.name, args: call.input || {} }));
}

export function formatGoogleFunctionCalls(
	calls: ParsedToolCall[] | null | undefined,
	tools: ToolBundle | null | undefined,
): GoogleFunctionCall[] {
	if (!calls?.length) return [];
	return toGoogleFunctionCalls(normalizeGoogleParsedCalls(calls, tools));
}

/** Extract DSML/XML tool-call blocks -> [cleanText, functionCalls]. */
export function parseGoogleFunctionCalls(
	text: unknown,
	tools: ToolBundle | null | undefined,
): [string, GoogleFunctionCall[]] {
	const parsed = parseDSMLToolCallsDetailed(text);
	if (parsed.calls.length) {
		return [parsed.cleanText, formatGoogleFunctionCalls(parsed.calls, tools)];
	}
	return [String(text || ""), []];
}
