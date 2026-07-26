import type { CompletionTextInput } from "../completion/ports";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import { isAbortError } from "../shared/abort";
import type { GeminiAuthenticatedSessionReason } from "../shared/errors";
import {
	errorLogSummary,
	geminiAuthenticatedSessionRequiredError,
} from "../shared/errors";
import { log } from "../shared/logging";
import type { ErrorWithMetadata } from "../shared/types";
import { classifyGeminiAccountOutcome } from "./accounts/domain";
import type { GeminiAccountLease } from "./accounts/lease";
import { capabilityFreshAfterMs } from "./accounts/pool-snapshot";
import { basicRouteForFamily } from "./accounts/routes";
import type { AccountPoolService } from "./accounts/pool";
import type { GeminiAccountRouteRequirement } from "./accounts/types";
import type { UploadReplayState } from "./upload-replay";

export type ResolvedModelOK = Extract<ResolvedModel, { name: string }>;

export type AttemptSession = {
	cfg: RuntimeConfig;
	accountPool: AccountPoolService | null;
	uploads: UploadReplayState;
	leasePromise: Promise<GeminiAccountLease | null> | null;
	lease: GeminiAccountLease | null;
	accountAttempts: number;
	disposed: boolean;
	activeRouteRequirement: GeminiAccountRouteRequirement | null;
	activeResolvedModelName: string;
	activeResolvedModel: ResolvedModelOK | null;
	activeRoutingPrepared: boolean;
	attemptedAccountIds: Set<string>;
	refreshedAccountIds: Set<string>;
};

export function createAttemptSession(
	cfg: RuntimeConfig,
	accountPool: AccountPoolService | null,
	uploads: UploadReplayState,
): AttemptSession {
	return {
		cfg,
		accountPool,
		uploads,
		leasePromise: null,
		lease: null,
		accountAttempts: 0,
		disposed: false,
		activeRouteRequirement: null,
		activeResolvedModelName: "",
		activeResolvedModel: null,
		activeRoutingPrepared: false,
		attemptedAccountIds: new Set(),
		refreshedAccountIds: new Set(),
	};
}

export function releaseLease(session: AttemptSession): void {
	if (session.lease) session.lease.release();
	session.lease = null;
	session.leasePromise = null;
}

export function resetAttemptState(session: AttemptSession): void {
	session.accountAttempts = 0;
	session.attemptedAccountIds.clear();
	session.refreshedAccountIds.clear();
	session.uploads.reset();
	session.activeRouteRequirement = null;
	session.activeResolvedModelName = "";
	session.activeResolvedModel = null;
	session.activeRoutingPrepared = false;
}

export function noAvailableAccountError(): ErrorWithMetadata {
	const error: ErrorWithMetadata = new Error("no available Gemini account");
	error.code = "no_available_gemini_account";
	error.status = 503;
	return error;
}

export function accountAttemptLimit(cfg: RuntimeConfig): number {
	const value = Number(cfg.gemini_account_max_attempts);
	return Number.isSafeInteger(value) && value > 0 ? value : 10;
}

export async function acquireAccountConfig(
	session: AttemptSession,
	reason: GeminiAuthenticatedSessionReason,
): Promise<RuntimeConfig> {
	if (!session.accountPool)
		throw geminiAuthenticatedSessionRequiredError(reason);
	if (session.disposed)
		throw new Error("Gemini completion provider is disposed");
	if (session.activeResolvedModel && !session.activeRoutingPrepared)
		await ensureModelRouting(
			session,
			session.activeResolvedModel,
			session.accountPool,
		);
	if (!session.leasePromise) {
		if (session.accountAttempts >= accountAttemptLimit(session.cfg))
			throw noAvailableAccountError();
		session.leasePromise = session.accountPool
			.acquireLease(session.cfg, {
				excludeAccountIds: session.attemptedAccountIds,
				...(session.activeRouteRequirement
					? { routeRequirement: session.activeRouteRequirement }
					: {}),
				capabilityMode: session.cfg.gemini_account_capability_mode || "prefer",
				capabilityFreshAfterMs: capabilityFreshAfterMs(
					session.cfg.gemini_account_capability_ttl_sec,
					Date.now(),
				),
			})
			.then((acquiredLease) => {
				if (!acquiredLease) throw noAvailableAccountError();
				if (session.attemptedAccountIds.has(acquiredLease.accountId)) {
					acquiredLease.release();
					throw noAvailableAccountError();
				}
				session.accountAttempts += 1;
				session.lease = acquiredLease;
				return acquiredLease;
			});
	}
	let selected: GeminiAccountLease | null;
	try {
		selected = await session.leasePromise;
	} catch (error) {
		session.leasePromise = null;
		throw error;
	}
	if (!selected) throw noAvailableAccountError();
	return selected.config;
}

export async function prepareAuthenticatedGeneration(
	session: AttemptSession,
	reason: GeminiAuthenticatedSessionReason,
): Promise<void> {
	await session.uploads.waitForPending();
	await acquireAccountConfig(session, reason);
}

export async function ensureModelRouting(
	session: AttemptSession,
	model: ResolvedModelOK,
	accountPool: AccountPoolService,
): Promise<void> {
	if (
		session.activeRoutingPrepared &&
		session.activeResolvedModelName === model.name
	)
		return;
	const candidates = await accountPool.routeCandidatesForModel(
		model,
		capabilityFreshAfterMs(
			session.cfg.gemini_account_capability_ttl_sec,
			Date.now(),
		),
	);
	session.activeRouteRequirement = {
		candidates,
		fallbackRoute: model.family ? basicRouteForFamily(model.family) : null,
	};
	session.activeResolvedModelName = model.name;
	session.activeResolvedModel = model;
	session.activeRoutingPrepared = true;
}

export async function finalizeOutcome(
	session: AttemptSession,
	kind: "success" | "failure",
	error?: unknown,
): Promise<void> {
	const selected = session.lease;
	let persistence: Promise<void> | null = null;
	if (selected) {
		try {
			persistence =
				kind === "success"
					? selected.markSuccess()
					: error !== undefined && !isAbortError(error)
						? selected.markFailure(error)
						: null;
		} catch (persistenceError) {
			log(
				session.cfg,
				`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
			);
		}
	}
	const maintenance =
		kind === "success" && selected
			? (persistence
					? guardOutcome(session, persistence)
					: Promise.resolve()
				).then(async () => {
					try {
						await selected.flushObservedCookies();
					} catch (cookieError) {
						log(
							session.cfg,
							`account response cookie writeback failed: ${errorLogSummary(cookieError)}`,
						);
					}
					const intervalSec = Number(
						session.cfg.gemini_account_refresh_interval_sec,
					);
					if (intervalSec > 0)
						await selected.maintainSessionIfStale(intervalSec * 1000);
				})
			: null;
	releaseLease(session);
	resetAttemptState(session);
	if (maintenance) {
		const guardedMaintenance = maintenance.catch((maintenanceError) => {
			log(
				session.cfg,
				`opportunistic account refresh failed: ${errorLogSummary(maintenanceError)}`,
			);
		});
		if (session.cfg.execution_ctx) {
			try {
				session.cfg.execution_ctx.waitUntil(guardedMaintenance);
			} catch (registrationError) {
				log(
					session.cfg,
					`account maintenance waitUntil registration failed: ${errorLogSummary(registrationError)}`,
				);
			}
			return;
		}
		await guardedMaintenance;
		return;
	}
	if (!persistence) return;
	const guarded = guardOutcome(session, persistence);
	if (session.cfg.execution_ctx) {
		try {
			session.cfg.execution_ctx.waitUntil(guarded);
		} catch (registrationError) {
			log(
				session.cfg,
				`account outcome waitUntil registration failed: ${errorLogSummary(registrationError)}`,
			);
		}
		return;
	}
	await guarded;
}

export function guardOutcome(
	session: AttemptSession,
	persistence: Promise<void>,
): Promise<void> {
	return persistence.catch((persistenceError: unknown) => {
		log(
			session.cfg,
			`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
		);
	});
}

export type RecoveryResult = { retry: true } | { retry: false; error: unknown };

export async function recoverAccount(
	session: AttemptSession,
	initialError: unknown,
	allowAccountSwitch: boolean,
): Promise<RecoveryResult> {
	let error = initialError;
	while (session.lease) {
		if (isAbortError(error)) return { retry: false, error };
		const outcome = classifyGeminiAccountOutcome(error, Date.now());
		const recoveryScope =
			outcome.recoveryScope ?? (outcome.issue ? "try_next_account" : "none");
		if (recoveryScope === "none") return { retry: false, error };

		const selected = session.lease;
		if (
			outcome.issue === "auth" &&
			!session.refreshedAccountIds.has(selected.accountId)
		) {
			session.refreshedAccountIds.add(selected.accountId);
			try {
				const refreshed = await selected.refreshForRetry("auth");
				if (refreshed.changed) return { retry: true };
			} catch (refreshError) {
				log(
					session.cfg,
					`account credential refresh failed: ${errorLogSummary(refreshError)}`,
				);
			}
		}

		if (
			recoveryScope !== "try_next_account" ||
			!allowAccountSwitch ||
			session.accountAttempts >= accountAttemptLimit(session.cfg)
		)
			return { retry: false, error };

		await retireLease(session, error);
		try {
			await acquireAccountConfig(session, "attachment");
		} catch (_) {
			return { retry: false, error };
		}
		try {
			const activeCfg = session.lease?.config;
			if (!activeCfg) throw noAvailableAccountError();
			await session.uploads.replay(activeCfg);
			return { retry: true };
		} catch (replayError) {
			error = replayError;
		}
	}
	return { retry: false, error };
}

async function retireLease(
	session: AttemptSession,
	error: unknown,
): Promise<void> {
	const selected = session.lease;
	if (!selected) return;
	session.attemptedAccountIds.add(selected.accountId);
	try {
		await guardOutcome(session, selected.markFailure(error));
	} catch (persistenceError) {
		log(
			session.cfg,
			`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
		);
	}
	releaseLease(session);
}

export class GeminiAccountAttemptOrchestrator {
	private readonly session: AttemptSession;

	constructor(
		cfg: RuntimeConfig,
		accountPool: AccountPoolService | null,
		uploads: UploadReplayState,
	) {
		this.session = createAttemptSession(cfg, accountPool, uploads);
	}

	get currentLease(): GeminiAccountLease | null {
		return this.session.lease;
	}

	get hasLeasePromise(): boolean {
		return this.session.leasePromise !== null;
	}

	setResolvedModel(model: ResolvedModelOK): void {
		this.session.activeResolvedModel = model;
		this.session.activeResolvedModelName = model.name;
		this.session.activeRoutingPrepared = false;
		this.session.activeRouteRequirement = null;
	}

	activateResolvedModel(model: ResolvedModelOK): void {
		this.session.activeResolvedModel = model;
		this.session.activeResolvedModelName = model.name;
	}

	acquireAccountConfig(
		reason: GeminiAuthenticatedSessionReason,
	): Promise<RuntimeConfig> {
		return acquireAccountConfig(this.session, reason);
	}

	prepareAuthenticatedGeneration(
		reason: GeminiAuthenticatedSessionReason,
	): Promise<void> {
		return prepareAuthenticatedGeneration(this.session, reason);
	}

	finalizeOutcome(kind: "success" | "failure", error?: unknown): Promise<void> {
		return finalizeOutcome(this.session, kind, error);
	}

	recoverAccount(
		initialError: unknown,
		allowAccountSwitch: boolean,
	): Promise<RecoveryResult> {
		return recoverAccount(this.session, initialError, allowAccountSwitch);
	}

	async withGeneration<T>(
		fn: (
			activeCfg: RuntimeConfig,
			activeInput: CompletionTextInput,
		) => Promise<T>,
		reason: GeminiAuthenticatedSessionReason,
		input: CompletionTextInput,
	): Promise<T> {
		await prepareAuthenticatedGeneration(this.session, reason);
		while (this.session.lease) {
			try {
				const result = await fn(
					this.session.lease.config,
					this.session.uploads.remapInput(input),
				);
				await finalizeOutcome(this.session, "success");
				return result;
			} catch (error) {
				const recovery = await recoverAccount(
					this.session,
					error,
					!this.session.uploads.hasOpaqueRefs(input),
				);
				if (recovery.retry) continue;
				await finalizeOutcome(this.session, "failure", recovery.error);
				throw recovery.error;
			}
		}
		throw noAvailableAccountError();
	}

	async *streamGeneration(
		fn: (
			activeCfg: RuntimeConfig,
			activeInput: CompletionTextInput,
		) => AsyncIterable<string>,
		reason: GeminiAuthenticatedSessionReason,
		input: CompletionTextInput,
		prepared = false,
	): AsyncGenerator<string> {
		let finalized = false;
		try {
			if (!prepared) await prepareAuthenticatedGeneration(this.session, reason);
			while (this.session.lease) {
				let emitted = false;
				try {
					for await (const delta of fn(
						this.session.lease.config,
						this.session.uploads.remapInput(input),
					)) {
						const text = String(delta || "");
						if (!text) continue;
						emitted = true;
						yield text;
					}
					await finalizeOutcome(this.session, "success");
					finalized = true;
					return;
				} catch (error) {
					if (emitted) {
						await finalizeOutcome(this.session, "failure", error);
						finalized = true;
						throw error;
					}
					const recovery = await recoverAccount(
						this.session,
						error,
						!this.session.uploads.hasOpaqueRefs(input),
					);
					if (recovery.retry) continue;
					await finalizeOutcome(this.session, "failure", recovery.error);
					finalized = true;
					throw recovery.error;
				}
			}
			throw noAvailableAccountError();
		} finally {
			if (!finalized && this.session.lease) {
				releaseLease(this.session);
				resetAttemptState(this.session);
			}
		}
	}

	withUpload<T>(
		fn: (activeCfg: RuntimeConfig) => Promise<T>,
		reason: GeminiAuthenticatedSessionReason,
		record: (result: T) => void,
	): Promise<T> {
		return this.session.uploads.serialize(async () => {
			await acquireAccountConfig(this.session, reason);
			while (this.session.lease) {
				try {
					const result = await fn(this.session.lease.config);
					record(result);
					return result;
				} catch (error) {
					const recovery = await recoverAccount(this.session, error, true);
					if (recovery.retry) continue;
					await finalizeOutcome(this.session, "failure", recovery.error);
					throw recovery.error;
				}
			}
			throw noAvailableAccountError();
		});
	}

	async dispose(): Promise<void> {
		if (this.session.disposed) return;
		this.session.disposed = true;
		try {
			await this.session.leasePromise;
		} catch (_) {
			// Acquisition failure has no lease to release.
		}
		releaseLease(this.session);
		resetAttemptState(this.session);
	}
}
