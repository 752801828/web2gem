import { uuid } from "../../shared/crypto";
import {
	COOKIE_ROTATE_MIN_INTERVAL_MS,
	mergeSetCookieHeaders,
	parseCookieHeader,
} from "../cookies";
import {
	identityHashFromCookie,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./domain";
import type {
	GeminiAccountCookieRotator,
	GeminiAccountRefreshResult,
} from "./lease";
import { createAccountSessionConfig, type PoolLease } from "./lease";
import { applyRefreshToSnapshot, type PoolAccountState } from "./pool-snapshot";
import type {
	GeminiAccountVerificationLevel,
	GeminiAccountVerifier,
} from "./probe";
import type { GeminiAccountSnapshotRow, GeminiAccountStore } from "./types";

export type PoolRefreshHost = {
	store: GeminiAccountStore;
	rotateCookie: GeminiAccountCookieRotator;
	verifyAccount: GeminiAccountVerifier;
	refreshLockTtlMs: number;
	nowMs: () => number;
	accountStates: Map<string, PoolAccountState>;
	pendingRefresh: Map<string, Promise<GeminiAccountRefreshResult>>;
	getSnapshotRows: () => GeminiAccountSnapshotRow[];
	setSnapshotRows: (rows: GeminiAccountSnapshotRow[]) => void;
	markSuccess(accountId: string, nowMs?: number): Promise<void>;
	markFailure(accountId: string, error: unknown, nowMs?: number): Promise<void>;
};

export function refreshAccount(
	host: PoolRefreshHost,
	lease: PoolLease,
	verificationLevel: GeminiAccountVerificationLevel,
	recordFailure: boolean,
): Promise<GeminiAccountRefreshResult> {
	const pendingKey = `${lease.accountId}\0${lease.cookieHash}\0${verificationLevel}`;
	const pending = host.pendingRefresh.get(pendingKey);
	if (pending) return pending;
	const promise = refreshForRetryOnce(
		host,
		lease,
		verificationLevel,
		recordFailure,
	).finally(() => {
		host.pendingRefresh.delete(pendingKey);
	});
	host.pendingRefresh.set(pendingKey, promise);
	return promise;
}

export async function persistObservedCookies(
	host: PoolRefreshHost,
	lease: PoolLease,
	setCookieValues: readonly string[],
): Promise<void> {
	if (!setCookieValues.length) return;
	const nowMs = host.nowMs();
	const owner = `account-response-cookie:${lease.accountId}:${uuid()}`;
	const locked = await host.store.tryAcquireRefreshLock(
		lease.accountId,
		owner,
		nowMs + host.refreshLockTtlMs,
		nowMs,
	);
	if (!locked) return;
	try {
		const account = await host.store.getAccountForRefresh(lease.accountId);
		if (!account) return;
		const cookieHeader = normalizeGeminiCookieHeader(
			mergeSetCookieHeaders(account.cookie_header, setCookieValues),
		);
		if (!cookieHeader) return;
		let identityHash = "";
		try {
			identityHash = await identityHashFromCookie(cookieHeader);
		} catch (_) {
			return;
		}
		if (identityHash !== account.identity_hash) return;
		const cookieHash = await sha256Hex(cookieHeader);
		if (cookieHash === account.cookie_hash) return;
		const writeback = await host.store.writeRefreshedCookie(lease.accountId, {
			cookieHeader,
			refreshedAtMs: nowMs,
			nowMs,
		});
		if (!writeback.changed) return;
		lease.updateCookie(cookieHeader, cookieHash, nowMs);
		host.accountStates.set(lease.accountId, {
			cookieHeader,
			cookieHash,
			lastRotateAtMs: 0,
		});
		host.setSnapshotRows(
			applyRefreshToSnapshot(
				host.getSnapshotRows(),
				lease.accountId,
				cookieHeader,
				cookieHash,
			),
		);
	} finally {
		await host.store.releaseRefreshLock(lease.accountId, owner);
	}
}

async function refreshForRetryOnce(
	host: PoolRefreshHost,
	lease: PoolLease,
	verificationLevel: GeminiAccountVerificationLevel,
	recordFailure: boolean,
): Promise<GeminiAccountRefreshResult> {
	const state = await accountState(host, lease);
	const nowMs = host.nowMs();
	if (!parseCookieHeader(state.cookieHeader).get("__Secure-1PSID")) {
		if (recordFailure)
			await host.markFailure(
				lease.accountId,
				{ code: "invalid_gemini_cookie" },
				nowMs,
			);
		return { changed: false, reason: "missing_secure_1psid" };
	}
	if (
		state.lastRotateAtMs > 0 &&
		nowMs - state.lastRotateAtMs < COOKIE_ROTATE_MIN_INTERVAL_MS
	) {
		return { changed: false, reason: "recent_rotation" };
	}
	return refreshAccountOnce(
		host,
		lease,
		state,
		nowMs,
		verificationLevel,
		recordFailure,
	);
}

async function refreshAccountOnce(
	host: PoolRefreshHost,
	lease: PoolLease,
	state: PoolAccountState,
	nowMs: number,
	verificationLevel: GeminiAccountVerificationLevel,
	recordFailure: boolean,
): Promise<GeminiAccountRefreshResult> {
	const owner = `account-refresh:${lease.accountId}:${uuid()}`;
	const locked = await host.store.tryAcquireRefreshLock(
		lease.accountId,
		owner,
		nowMs + host.refreshLockTtlMs,
		nowMs,
	);
	if (!locked) return { changed: false, reason: "lock_conflict" };
	try {
		const account = await host.store.getAccountForRefresh(lease.accountId);
		if (!account) return { changed: false, reason: "account_missing" };
		const response = await host.rotateCookie({
			config: lease.config,
			account,
		});
		state.lastRotateAtMs = nowMs;
		if (!response.ok) {
			if (recordFailure)
				await host.markFailure(
					lease.accountId,
					{ status: response.status },
					nowMs,
				);
			return {
				changed: false,
				reason:
					response.status === 401 || response.status === 403
						? "rotation_rejected"
						: "rotation_failed",
			};
		}
		const nextCookieHeader = normalizeGeminiCookieHeader(
			mergeSetCookieHeaders(
				account.cookie_header,
				response.headers.getSetCookie(),
			),
		);
		if (!nextCookieHeader) {
			if (recordFailure)
				await host.markFailure(
					lease.accountId,
					{ code: "invalid_gemini_cookie" },
					nowMs,
				);
			return {
				changed: false,
				reason: "rotation_failed",
			};
		}
		const nextCookieHash = await sha256Hex(nextCookieHeader);
		const nextAccount = {
			...account,
			cookie_header: nextCookieHeader,
			cookie_hash: nextCookieHash,
		};
		const nextConfig = createAccountSessionConfig(lease.config, nextAccount);
		const verification = await host.verifyAccount({
			config: nextConfig,
			level: verificationLevel,
		});
		if (!verification.ok) {
			if (recordFailure && verification.reason === "missing_page_at_token")
				await host.markFailure(
					lease.accountId,
					{ code: "missing_page_at_token" },
					nowMs,
				);
			return { changed: false, reason: verification.reason };
		}
		const writeback = await host.store.writeRefreshedCookie(lease.accountId, {
			cookieHeader: nextCookieHeader,
			refreshedAtMs: nowMs,
			nowMs,
		});
		if (!writeback.changed && writeback.reason === "duplicate_cookie") {
			return {
				changed: false,
				reason: "rotation_duplicate",
			};
		}
		lease.updateCookie(nextCookieHeader, nextCookieHash, nowMs, nextConfig);
		host.accountStates.set(lease.accountId, {
			cookieHeader: nextCookieHeader,
			cookieHash: nextCookieHash,
			lastRotateAtMs: nowMs,
		});
		host.setSnapshotRows(
			applyRefreshToSnapshot(
				host.getSnapshotRows(),
				lease.accountId,
				nextCookieHeader,
				nextCookieHash,
			),
		);
		if (verification.probe) {
			await host.store.writeAccountProbe(
				lease.accountId,
				verification.probe,
				nowMs,
			);
			if (verification.probe.issue) {
				await host.markFailure(
					lease.accountId,
					{
						geminiSource: "account_status",
						geminiCode: String(verification.probe.statusCode),
					},
					nowMs,
				);
				return {
					changed: writeback.changed,
					reason: "status_restricted",
				};
			}
			await host.markSuccess(lease.accountId, nowMs);
		}
		return {
			changed: writeback.changed,
			reason: writeback.changed ? "rotation_updated" : "rotation_no_update",
		};
	} catch (error) {
		if (recordFailure)
			await host
				.markFailure(lease.accountId, error, nowMs)
				.catch(() => undefined);
		throw error;
	} finally {
		await host.store.releaseRefreshLock(lease.accountId, owner);
	}
}

async function accountState(
	host: PoolRefreshHost,
	lease: PoolLease,
): Promise<PoolAccountState> {
	const existing = host.accountStates.get(lease.accountId);
	if (existing && existing.cookieHash === lease.cookieHash) return existing;
	const cookieHeader = normalizeGeminiCookieHeader(lease.cookieHeader);
	const cookieHash = await sha256Hex(cookieHeader);
	const state = { cookieHeader, cookieHash, lastRotateAtMs: 0 };
	host.accountStates.set(lease.accountId, state);
	return state;
}
