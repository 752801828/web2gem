import type { RuntimeConfig } from "../../config";
import { extractCookieValue } from "../cookies";
import { normalizeGeminiCookieHeader } from "./domain";
import type { GeminiAccountModelCapability, GeminiRouteTuple } from "./routes";
import type { GeminiAccountSecretRow, GeminiAccountSnapshotRow } from "./types";

export type GeminiAccountCookieRotator = (input: {
	config: RuntimeConfig;
	account: GeminiAccountSecretRow;
}) => Promise<GeminiAccountRotateResponse>;

export type GeminiAccountRotateResponse = {
	status: number;
	ok: boolean;
	headers: Headers;
};

export type GeminiAccountLease = {
	accountId: string;
	selectedRoute: GeminiRouteTuple | null;
	modelCapability: GeminiAccountModelCapability | null;
	config: RuntimeConfig;
	refreshForRetry(reason?: string): Promise<GeminiAccountRefreshResult>;
	markSuccess(nowMs?: number): Promise<void>;
	markFailure(error: unknown, nowMs?: number): Promise<void>;
	flushObservedCookies(): Promise<void>;
	maintainSessionIfStale(intervalMs: number): Promise<void>;
	release(): void;
};

export type GeminiAccountRefreshReason =
	| "missing_secure_1psid"
	| "recent_rotation"
	| "lock_conflict"
	| "account_missing"
	| "rotation_rejected"
	| "rotation_failed"
	| "rotation_no_update"
	| "rotation_duplicate"
	| "rotation_updated"
	| "missing_page_at_token"
	| "status_probe_failed"
	| "status_restricted";

export type GeminiAccountRefreshResult = {
	changed: boolean;
	reason: GeminiAccountRefreshReason;
};

const MAX_OBSERVED_SET_COOKIE_HEADERS = 64;
const MAX_OBSERVED_SET_COOKIE_CHARS = 8192;

export interface PoolLeaseHost {
	refreshForRetry(
		lease: PoolLease,
		recordFailure?: boolean,
	): Promise<GeminiAccountRefreshResult>;
	markSuccess(accountId: string, nowMs?: number): Promise<void>;
	markFailure(accountId: string, error: unknown, nowMs?: number): Promise<void>;
	persistObservedCookies(
		lease: PoolLease,
		setCookieValues: readonly string[],
	): Promise<void>;
	release(accountId: string): void;
}

export class PoolLease implements GeminiAccountLease {
	readonly accountId: string;
	readonly selectedRoute: GeminiRouteTuple | null;
	readonly modelCapability: GeminiAccountModelCapability | null;
	config: RuntimeConfig;
	cookieHeader: string;
	cookieHash: string;
	private released = false;
	private lastRefreshSuccessAtMs: number;
	private readonly observedSetCookieValues: string[] = [];

	constructor(
		private readonly pool: PoolLeaseHost,
		baseConfig: RuntimeConfig,
		row: Pick<
			GeminiAccountSnapshotRow,
			"id" | "cookie_header" | "cookie_hash" | "last_refresh_success_at_ms"
		>,
		modelCapability: GeminiAccountModelCapability | null = null,
		selectedRoute: GeminiRouteTuple | null = null,
	) {
		this.accountId = row.id;
		this.modelCapability = modelCapability;
		this.selectedRoute = selectedRoute;
		this.cookieHeader = row.cookie_header;
		this.cookieHash = row.cookie_hash;
		this.lastRefreshSuccessAtMs = Number(row.last_refresh_success_at_ms) || 0;
		this.config = createAccountSessionConfig(baseConfig, row, (values) =>
			this.observeSetCookie(values),
		);
	}

	refreshForRetry(reason?: string): Promise<GeminiAccountRefreshResult> {
		return this.pool.refreshForRetry(this, reason !== "auth");
	}

	markSuccess(nowMs?: number): Promise<void> {
		return this.pool.markSuccess(this.accountId, nowMs);
	}

	markFailure(error: unknown, nowMs?: number): Promise<void> {
		return this.pool.markFailure(this.accountId, error, nowMs);
	}

	async flushObservedCookies(): Promise<void> {
		if (!this.observedSetCookieValues.length) return;
		const values = this.observedSetCookieValues.splice(0);
		await this.pool.persistObservedCookies(this, values);
	}

	updateCookie(
		cookieHeader: string,
		cookieHash: string,
		refreshedAtMs: number,
		config?: RuntimeConfig,
	): void {
		this.cookieHeader = cookieHeader;
		this.cookieHash = cookieHash;
		this.lastRefreshSuccessAtMs = refreshedAtMs;
		this.config =
			config ||
			createAccountSessionConfig(
				this.config,
				{
					id: this.accountId,
					cookie_header: cookieHeader,
					cookie_hash: cookieHash,
				},
				(values) => this.observeSetCookie(values),
			);
	}

	async maintainSessionIfStale(intervalMs: number): Promise<void> {
		const nowMs = Date.now();
		if (
			!Number.isFinite(intervalMs) ||
			intervalMs <= 0 ||
			nowMs - this.lastRefreshSuccessAtMs < intervalMs
		)
			return;
		const result = await this.pool.refreshForRetry(this, false);
		if (
			result.reason === "rotation_updated" ||
			result.reason === "rotation_no_update"
		)
			this.lastRefreshSuccessAtMs = nowMs;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.pool.release(this.accountId);
	}

	private observeSetCookie(values: readonly string[]): void {
		for (const value of values) {
			if (
				this.observedSetCookieValues.length >= MAX_OBSERVED_SET_COOKIE_HEADERS
			)
				break;
			if (value.length > MAX_OBSERVED_SET_COOKIE_CHARS) continue;
			if (value) this.observedSetCookieValues.push(value);
		}
	}
}

export function createAccountSessionConfig(
	baseConfig: RuntimeConfig,
	row: Pick<GeminiAccountSnapshotRow, "id" | "cookie_header" | "cookie_hash">,
	observeSetCookie?: (values: readonly string[]) => void,
): RuntimeConfig {
	const cookie = normalizeGeminiCookieHeader(row.cookie_header);
	const observer =
		observeSetCookie || baseConfig.gemini_account?.observeSetCookie;
	return {
		...baseConfig,
		cookie,
		sapisid: extractCookieValue(cookie, "SAPISID"),
		gemini_account: {
			accountId: row.id,
			cookieHash: row.cookie_hash,
			...(observer ? { observeSetCookie: observer } : {}),
		},
	};
}
