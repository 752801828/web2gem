import { bytesToHex } from "../../shared/crypto";
import { TEXT_ENCODER } from "../../shared/encoding";
import { parseCookieHeader, serializeCookieMap } from "../cookies";

const GEMINI_ACCOUNT_ISSUES = [
	"auth",
	"rate_limit",
	"user_action",
	"location",
	"transient",
] as const;

export type GeminiAccountIssue = (typeof GEMINI_ACCOUNT_ISSUES)[number];

const GEMINI_ACCOUNT_STATES = [
	"available",
	"cooling",
	"attention",
	"disabled",
] as const;

export type GeminiAccountState = (typeof GEMINI_ACCOUNT_STATES)[number];

export type GeminiAccountOutcome = {
	kind: "success" | "failure";
	issue?: GeminiAccountIssue;
	cooldownUntilMs?: number;
	recoveryScope?: "none" | "retry_same_account" | "try_next_account";
	nowMs: number;
};

type D1ResultLike = {
	meta?: unknown;
	success?: boolean;
};

const STATE_SET = new Set<string>(GEMINI_ACCOUNT_STATES);
export const GEMINI_DURABLE_ACCOUNT_ISSUES = [
	"auth",
	"user_action",
	"location",
] as const satisfies readonly GeminiAccountIssue[];
const GEMINI_TEMPORARY_ACCOUNT_ISSUES = [
	"rate_limit",
	"transient",
] as const satisfies readonly GeminiAccountIssue[];

const DURABLE_BLOCKING_ISSUES = new Set<GeminiAccountIssue>(
	GEMINI_DURABLE_ACCOUNT_ISSUES,
);
const TEMPORARY_ISSUES = new Set<GeminiAccountIssue>(
	GEMINI_TEMPORARY_ACCOUNT_ISSUES,
);

export function isGeminiAccountState(
	value: string,
): value is GeminiAccountState {
	return STATE_SET.has(value);
}

export function isDurableGeminiAccountIssue(
	issue: GeminiAccountIssue | null | undefined,
): boolean {
	return issue != null && DURABLE_BLOCKING_ISSUES.has(issue);
}

function isTemporaryGeminiAccountIssue(
	issue: GeminiAccountIssue | null | undefined,
): boolean {
	return issue != null && TEMPORARY_ISSUES.has(issue);
}

export function geminiAccountState(
	account: {
		enabled: number | boolean;
		issue: GeminiAccountIssue | null;
		cooldown_until_ms: number | null;
	},
	nowMs: number,
): GeminiAccountState {
	if (account.enabled === false || Number(account.enabled) !== 1)
		return "disabled";
	if (account.cooldown_until_ms != null && account.cooldown_until_ms > nowMs)
		return "cooling";
	if (isDurableGeminiAccountIssue(account.issue)) return "attention";
	return "available";
}

export function visibleGeminiAccountIssue(
	account: {
		issue: GeminiAccountIssue | null;
		cooldown_until_ms: number | null;
	},
	nowMs: number,
): GeminiAccountIssue | null {
	if (
		isTemporaryGeminiAccountIssue(account.issue) &&
		(account.cooldown_until_ms == null || account.cooldown_until_ms <= nowMs)
	)
		return null;
	return account.issue;
}

export function boundedGeminiAccountPageLimit(value: unknown): number {
	const limit = Number(value);
	if (!Number.isInteger(limit)) return 50;
	return Math.min(Math.max(limit, 1), 200);
}

const SESSION_TOKEN_FIELDS = new Set(["SNlM0e", "session_token", "at"]);

export function cleanAccountString(value: unknown): string {
	return String(value ?? "")
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/;+$/g, "")
		.trim();
}

export function normalizeGeminiCookieHeader(cookieHeader: unknown): string {
	const cookies = parseCookieHeader(cookieHeader);
	for (const field of SESSION_TOKEN_FIELDS) cookies.delete(field);
	return serializeCookieMap(cookies);
}

export async function sha256Hex(value: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
	return bytesToHex(new Uint8Array(buf));
}

export async function identityHashFromCookie(
	cookieHeader: unknown,
): Promise<string> {
	const psid = parseCookieHeader(normalizeGeminiCookieHeader(cookieHeader)).get(
		"__Secure-1PSID",
	);
	if (!psid) throw new Error("Gemini account identity requires __Secure-1PSID");
	return sha256Hex(psid);
}

export function changedRows(meta: unknown): number | null {
	if (!meta || typeof meta !== "object") return null;
	const record = meta as Record<string, unknown>;
	for (const key of ["changes", "changedRows", "rows_written", "rowsWritten"]) {
		const value = Number(record[key]);
		if (Number.isInteger(value) && value >= 0) return value;
	}
	return null;
}

export function resultChanged(result: D1ResultLike): number {
	const rows = changedRows(result.meta);
	return rows == null ? 1 : rows;
}

export function isD1UniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /unique constraint failed|constraint.*unique|SQLITE_CONSTRAINT/i.test(
		message,
	);
}

const AUTH_STATUSES = new Set([401, 403]);
const RATE_LIMIT_STATUSES = new Set([402, 429]);

const AUTH_MARKERS = [
	"invalid_gemini_cookie",
	"missing_page_at_token",
	"missing gemini page auth token",
	"login required",
	"sign in",
	"unauthorized",
	"forbidden",
];

const USER_ACTION_MARKERS = [
	"terms of service",
	"guardian",
	"parent approval",
	"verify your age",
	"needs user action",
];

const LOCATION_BLOCK_MARKERS = [
	"not available in your country",
	"location",
	"ip block",
	"unsupported region",
];

const REQUEST_SCOPED_MARKERS = [
	"model invalid",
	"invalid model",
	"capability",
	"model not available",
];

export function classifyGeminiAccountOutcome(
	error: unknown,
	nowMs: number,
): GeminiAccountOutcome {
	const upstreamStatus =
		numericField(error, "upstreamStatus") ?? numericField(error, "status");
	const code = stringField(error, "code");
	const text = safeErrorText(error);
	const lower = text.toLowerCase();
	const semanticSource = stringField(error, "geminiSource");
	const semanticCode = stringField(error, "geminiCode");
	if (
		code === "gemini_route_not_selected" ||
		code === "gemini_upload_replay_failed"
	)
		return { kind: "failure", recoveryScope: "none", nowMs };
	if (semanticSource === "account_status") {
		if (semanticCode === "1014")
			return {
				kind: "failure",
				issue: "transient",
				cooldownUntilMs: nowMs + 60 * 1000,
				recoveryScope: "none",
				nowMs,
			};
		if (semanticCode === "1016")
			return {
				kind: "failure",
				issue: "auth",
				recoveryScope: "none",
				nowMs,
			};
		if (["1021", "1033", "1040", "1042", "1054", "1057"].includes(semanticCode))
			return {
				kind: "failure",
				issue: "user_action",
				recoveryScope: "none",
				nowMs,
			};
		if (semanticCode === "1060")
			return {
				kind: "failure",
				issue: "location",
				recoveryScope: "none",
				nowMs,
			};
	}

	if (semanticSource === "stream_generate") {
		switch (semanticCode) {
			case "1013":
				return {
					kind: "failure",
					issue: "transient",
					cooldownUntilMs: nowMs + 60 * 1000,
					recoveryScope: "try_next_account",
					nowMs,
				};
			case "1037":
				return {
					kind: "failure",
					issue: "rate_limit",
					cooldownUntilMs: nowMs + 5 * 60 * 1000,
					recoveryScope: "try_next_account",
					nowMs,
				};
			case "1050":
				return {
					kind: "failure",
					recoveryScope: "try_next_account",
					nowMs,
				};
			case "1052":
			case "1060":
				return { kind: "failure", recoveryScope: "none", nowMs };
		}
	}

	if (
		AUTH_STATUSES.has(Number(upstreamStatus)) ||
		code === "invalid_gemini_cookie" ||
		hasMarker(lower, AUTH_MARKERS)
	) {
		return {
			kind: "failure",
			issue: "auth",
			recoveryScope: "try_next_account",
			nowMs,
		};
	}

	if (
		RATE_LIMIT_STATUSES.has(Number(upstreamStatus)) ||
		/\b(429|quota|rate limit|usage limit|1037)\b/i.test(text)
	) {
		return {
			kind: "failure",
			issue: "rate_limit",
			cooldownUntilMs: nowMs + 5 * 60 * 1000,
			recoveryScope: "try_next_account",
			nowMs,
		};
	}

	if (hasMarker(lower, USER_ACTION_MARKERS)) {
		return {
			kind: "failure",
			issue: "user_action",
			recoveryScope: "try_next_account",
			nowMs,
		};
	}

	if (hasMarker(lower, LOCATION_BLOCK_MARKERS) || /\b1060\b/.test(text)) {
		return {
			kind: "failure",
			issue: "location",
			recoveryScope: "try_next_account",
			nowMs,
		};
	}

	if (
		/\b(1050|1052)\b/.test(text) ||
		hasMarker(lower, REQUEST_SCOPED_MARKERS)
	) {
		return { kind: "failure", recoveryScope: "none", nowMs };
	}

	return {
		kind: "failure",
		issue: "transient",
		cooldownUntilMs: nowMs + 60 * 1000,
		recoveryScope: "try_next_account",
		nowMs,
	};
}

function hasMarker(text: string, markers: readonly string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

function numericField(value: unknown, field: string): number | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = (value as Record<string, unknown>)[field];
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function stringField(value: unknown, field: string): string {
	if (!value || typeof value !== "object") return "";
	const raw = (value as Record<string, unknown>)[field];
	return raw == null ? "" : String(raw);
}

function safeErrorText(error: unknown): string {
	if (!error) return "";
	if (typeof error === "string") return error;
	if (typeof error === "object") {
		const record = error as Record<string, unknown>;
		return [
			record.code,
			record.reason,
			record.message,
			record.status,
			record.upstreamStatus,
		]
			.filter((value) => value !== undefined && value !== null)
			.map(String)
			.join(" ");
	}
	return String(error);
}
