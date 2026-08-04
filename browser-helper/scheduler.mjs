import { randomUUID } from "node:crypto";
import { BrowserMaintenanceError } from "./google-login.mjs";

export { BrowserMaintenanceError } from "./google-login.mjs";

const MODES = new Set(["scheduled", "manual_check", "visible"]);
const PRIORITY = { scheduled: 0, manual_check: 1, visible: 2 };
const MANUAL_CODES = new Set([
	"captcha",
	"passkey",
	"phone_approval",
	"recovery",
	"device_confirmation",
	"unknown_page",
]);
const AUTH_CODES = new Set(["missing_cookie", "login_failed"]);
const LEASE_TTL_SEC = 300;
const LEASE_RENEW_MS = 100_000;

export function jitteredDelayMs(intervalSec, jitterSec, random = Math.random) {
	if (
		!Number.isFinite(intervalSec) ||
		intervalSec < 0 ||
		!Number.isFinite(jitterSec) ||
		jitterSec < 0
	)
		throw new Error("invalid browser schedule interval");
	const sample = Math.min(1, Math.max(0, Number(random())));
	return Math.max(
		0,
		Math.round((intervalSec + (sample * 2 - 1) * jitterSec) * 1_000),
	);
}

export function createMaintenanceQueue(handler) {
	if (typeof handler !== "function") throw new Error("invalid maintenance handler");
	const pending = new Map();
	const reservations = new Set();
	let sequence = 0;
	let active = null;
	let worker = null;
	let accepting = true;

	function enqueue(input) {
		const job = validJob(input);
		if (!accepting) return Promise.resolve({ skipped: true });
		if (job.signal?.aborted) return Promise.resolve({ skipped: true });
		if (reservations.has(job.accountId)) return Promise.resolve({ skipped: true });
		if (
			active?.accountId === job.accountId &&
			!active.controller.signal.aborted &&
			PRIORITY[job.mode] <= PRIORITY[active.mode]
		)
			return addClaim(active, job);
		let queued = pending.get(job.accountId);
		if (!queued) {
			queued = queuedJob(job.accountId, sequence++);
			pending.set(job.accountId, queued);
		}
		const claim = addClaim(queued, job);
		recomputeMode(queued);
		startWorker();
		return claim;
	}

	function startWorker() {
		if (!worker)
			worker = drain().finally(() => {
				worker = null;
				if (pending.size && accepting) startWorker();
			});
	}

	async function drain() {
		while (pending.size) {
			const next = [...pending.values()].sort(
				(left, right) =>
					PRIORITY[right.mode] - PRIORITY[left.mode] || left.sequence - right.sequence,
			)[0];
			pending.delete(next.accountId);
			active = next;
			try {
				const result = await handler({
					accountId: next.accountId,
					mode: next.mode,
					signal: next.controller.signal,
				});
				settleClaims(next, "resolve", result);
			} catch (error) {
				settleClaims(next, "reject", error);
			} finally {
				active = null;
			}
		}
	}

	function addClaim(entry, job) {
		const claim = deferredClaim(job);
		entry.claims.push(claim);
		if (!claim.signal) return claim.promise;
		const abort = () => {
			const index = entry.claims.indexOf(claim);
			if (index < 0) return;
			entry.claims.splice(index, 1);
			claim.disposeAbort?.();
			claim.resolve({ skipped: true });
			if (!entry.claims.length) {
				if (pending.get(entry.accountId) === entry)
					pending.delete(entry.accountId);
				else if (active === entry) entry.controller.abort();
				return;
			}
			if (pending.get(entry.accountId) === entry) recomputeMode(entry);
		};
		claim.signal.addEventListener("abort", abort, { once: true });
		claim.disposeAbort = () =>
			claim.signal.removeEventListener?.("abort", abort);
		if (claim.signal.aborted) abort();
		return claim.promise;
	}

	return Object.freeze({
		enqueue,
		reserve(accountId) {
			if (
				!accepting ||
				typeof accountId !== "string" ||
				!accountId ||
				reservations.has(accountId) ||
				active?.accountId === accountId ||
				pending.has(accountId)
			)
				return null;
			reservations.add(accountId);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				reservations.delete(accountId);
			};
		},
		isBusy(accountId) {
			return (
				reservations.has(accountId) ||
				active?.accountId === accountId ||
				pending.has(accountId)
			);
		},
		async waitForIdle() {
			while (worker) await worker;
		},
		async stop() {
			accepting = false;
			for (const job of pending.values())
				settleClaims(job, "resolve", { skipped: true });
			pending.clear();
			while (worker) await worker;
		},
	});
}

export function createBrowserScheduler(config, dependencies) {
	const {
		client,
		browser,
		decryptCredentials,
		runLogin,
		notifier,
		clock = Date.now,
		random = Math.random,
		owner = `browser-helper-${randomUUID()}`,
		setTimer = setTimeout,
		clearTimer = clearTimeout,
		setLeaseTimer = setTimeout,
		clearLeaseTimer = clearTimeout,
		beforeVisibleStart = async () => null,
		onOperationalError = () => undefined,
	} = dependencies || {};
	if (
		!client ||
		!browser ||
		typeof decryptCredentials !== "function" ||
		typeof runLogin !== "function"
	)
		throw new Error("invalid browser scheduler dependencies");
	const accounts = new Map();
	let timer = null;
	let timerCycle = null;
	let started = false;
	let stopped = false;
	const queue = createMaintenanceQueue(maintain);

	async function scan() {
		if (stopped) return;
		await queue.waitForIdle();
		if (stopped) return;
		const listed = await client.listAccounts();
		if (stopped) return;
		accounts.clear();
		for (const account of listed) {
			accounts.set(account.id, account);
			queue.enqueue({ accountId: account.id, mode: "scheduled" });
		}
	}

	function arm() {
		if (stopped) return;
		timer = setTimer(() => {
			timer = null;
			timerCycle = (async () => {
				try {
					await scan();
				} catch {
					safeOperationalError(onOperationalError, "schedule_scan_failed");
				} finally {
					timerCycle = null;
					arm();
				}
			})();
		}, jitteredDelayMs(config.checkIntervalSec, config.checkJitterSec, random));
	}

	async function accountFor(accountId) {
		const known = accounts.get(accountId);
		if (known) return known;
		const listed = await client.listAccounts();
		accounts.clear();
		for (const account of listed) accounts.set(account.id, account);
		return accounts.get(accountId) || null;
	}

	async function maintain(job) {
		if (job.signal?.aborted) return { skipped: true };
		const account = await accountFor(job.accountId);
		if (!account) return { skipped: true };
		let leased = false;
		let opened = false;
		let browserClosed = false;
		let leaseLost = false;
		let leaseHeartbeatStopped = false;
		let leaseTimer = null;
		let leaseCycle = null;
		let candidateCommitted = false;
		const jobAbort = new AbortController();
		const cancelJob = () =>
			jobAbort.abort(new BrowserMaintenanceError("job_cancelled"));
		if (job.signal) {
			job.signal.addEventListener("abort", cancelJob, { once: true });
			if (job.signal.aborted) cancelJob();
		}
		let removeDisplayFailure = null;
		const closeBrowserOnce = async () => {
			if (!opened || browserClosed) return;
			browserClosed = true;
			try {
				await browser.close();
			} catch {
				safeOperationalError(onOperationalError, "browser_close_failed");
			}
		};
		const assertLeaseActive = () => {
			if (leaseLost) throw new BrowserMaintenanceError("lease_lost");
			if (jobAbort.signal.aborted)
				throw jobAbort.signal.reason instanceof Error
					? jobAbort.signal.reason
					: new BrowserMaintenanceError("job_cancelled");
		};
		const armLeaseHeartbeat = () => {
			if (!leased || leaseLost || leaseHeartbeatStopped) return;
			leaseTimer = setLeaseTimer(() => {
				leaseTimer = null;
				leaseCycle = (async () => {
					try {
						leaseLost = !(await client.acquireLease(
							account.id,
							owner,
							LEASE_TTL_SEC,
						));
					} catch {
						leaseLost = true;
					}
					if (leaseLost) {
						safeOperationalError(onOperationalError, "lease_lost");
						jobAbort.abort(new BrowserMaintenanceError("lease_lost"));
						await closeBrowserOnce();
						return;
					}
					armLeaseHeartbeat();
				})().finally(() => {
					leaseCycle = null;
				});
			}, LEASE_RENEW_MS);
		};
		const stopLeaseHeartbeat = async () => {
			leaseHeartbeatStopped = true;
			if (leaseTimer !== null) clearLeaseTimer(leaseTimer);
			leaseTimer = null;
			if (leaseCycle) await leaseCycle;
		};
		try {
			leased = await client.acquireLease(account.id, owner, LEASE_TTL_SEC);
			if (!leased) return { skipped: true };
			armLeaseHeartbeat();
			const nowMs = safeNow(clock);
			await client.patchState(
				account.id,
				statusUpdate(account, {
					state: "checking",
					lastCheckAtMs: nowMs,
					failureCode: null,
				}),
			);
			assertLeaseActive();
			if (job.mode === "visible") {
				const display = await beforeVisibleStart(account.id, jobAbort.signal);
				const failureSignal = display?.failureSignal;
				if (failureSignal) {
					const displayFailed = () =>
						jobAbort.abort(new BrowserMaintenanceError("display_failed"));
					failureSignal.addEventListener("abort", displayFailed, { once: true });
					removeDisplayFailure = () =>
						failureSignal.removeEventListener("abort", displayFailed);
					if (failureSignal.aborted) displayFailed();
				}
				assertLeaseActive();
			}
			const context = await (job.mode === "visible"
				? browser.startVisible(account.id)
				: browser.startHeadless(account.id));
			opened = true;
			assertLeaseActive();
			const hasStoredSession = await restoreStoredSession(
				context,
				client,
				account.id,
				nowMs,
				job.mode === "visible" &&
					account.status.failureCode ===
						"browser_cookie_verification_failed",
			);
			assertLeaseActive();
			const page = await activePage(context);
			const loginInput = {
				accountId: account.id,
				page,
				mode: job.mode,
				signal: jobAbort.signal,
				nowSeconds: Math.floor(nowMs / 1_000),
				serverDate: client.serverDate,
				maxClockSkewSec: config.maxClockSkewSec,
			};
			let autoLoginAtMs = account.status.lastAutoLoginAtMs;
			let storedCredentials = null;
			const loadCredentials = async () => {
				if (storedCredentials) return storedCredentials;
				const envelope = await client.getEncryptedCredentials(account.id);
				storedCredentials = decryptCredentials(account.id, envelope);
				return storedCredentials;
			};
			const canAttemptAutomaticLogin = (allowManualAction = false) =>
				account.status.credentialsConfigured &&
				(allowManualAction ||
					account.status.state !== "manual_action_required") &&
				config.autoLoginMaxAttemptsPerDay > 0 &&
				attemptsToday(account, localDate(nowMs)) <
					config.autoLoginMaxAttemptsPerDay;
			const runAutomaticLogin = async () => {
				const date = localDate(nowMs);
				const credentials = await loadCredentials();
				return runLogin({
					...loginInput,
					credentials,
					beforeSubmit: async () => {
						assertLeaseActive();
						let reservation;
						try {
							reservation = await client.recordAutoLoginAttempt(
								account.id,
								date,
								config.autoLoginMaxAttemptsPerDay,
							);
						} catch {
							throw new BrowserMaintenanceError(
								"attempt_reservation_failed",
							);
						}
						account.autoLoginAttemptDate = date;
						account.autoLoginAttemptCount = reservation.count;
						assertLeaseActive();
						if (!reservation.reserved)
							throw new BrowserMaintenanceError("auto_login_limit");
						autoLoginAtMs = nowMs;
					},
				});
			};
			let result =
				job.mode === "visible" && canAttemptAutomaticLogin(true)
					? await runAutomaticLogin()
					: await runLogin({
						...loginInput,
						credentials: undefined,
						identityEmail:
							(job.mode === "visible" || hasStoredSession) &&
							account.status.credentialsConfigured
								? (await loadCredentials()).email
								: null,
					});
			assertLeaseActive();
			if (
				!result.ok &&
				result.code === "login_failed" &&
				job.mode !== "visible"
			) {
				if (canAttemptAutomaticLogin()) result = await runAutomaticLogin();
			}
			assertLeaseActive();
			if (result.ok) {
				assertLeaseActive();
				const candidate = await client.submitCandidateCookie(account.id, {
					psid: result.psid,
					psidts: result.psidts,
					observedEmail: result.observedEmail,
				});
				candidateCommitted = true;
				const update = statusUpdate(account, {
					state: "ready",
					lastCheckAtMs: nowMs,
					lastCookieUpdateAtMs:
						candidate.lastCookieUpdateAtMs ?? account.status.lastCookieUpdateAtMs,
					lastAutoLoginAtMs: autoLoginAtMs,
					authFailureCount: 0,
					failureCode: null,
				});
				try {
					assertLeaseActive();
					await publishState(account, update, "ready");
				} catch {
					safeOperationalError(
						onOperationalError,
						"state_update_after_candidate_failed",
					);
				}
				return { ready: true };
			}
			if (MANUAL_CODES.has(result.code)) {
				const update = statusUpdate(account, {
					state: "manual_action_required",
					lastCheckAtMs: nowMs,
					lastAutoLoginAtMs: autoLoginAtMs,
					failureCode: safeFailureCode(result.code),
				});
				await publishState(account, update, result.code);
				return { ready: false };
			}
			if (account.status.state === "manual_action_required") {
				const update = statusUpdate(account, {
					state: "manual_action_required",
					lastCheckAtMs: nowMs,
					lastAutoLoginAtMs: autoLoginAtMs,
				});
				await publishState(account, update, account.status.failureCode);
				return { ready: false };
			}
			if (!AUTH_CODES.has(result.code)) {
				const update = statusUpdate(account, {
					state: "error",
					lastCheckAtMs: nowMs,
					lastAutoLoginAtMs: autoLoginAtMs,
					failureCode: safeFailureCode(result.code),
				});
				await publishState(account, update, result.code);
				return { ready: false };
			}
			const failures = account.authFailureCount + 1;
			const update = statusUpdate(account, {
				state: failures >= 2 ? "login_required" : "error",
				lastCheckAtMs: nowMs,
				lastAutoLoginAtMs: autoLoginAtMs,
				authFailureCount: failures,
				failureCode: safeFailureCode(result.code),
			});
			await publishState(account, update, result.code);
			return { ready: false };
		} catch (error) {
			if (candidateCommitted) {
				safeOperationalError(
					onOperationalError,
					"state_update_after_candidate_failed",
				);
				return { ready: true };
			}
			if (
				leased &&
				!leaseLost &&
				jobAbort.signal.reason?.code !== "job_cancelled"
			) {
				const code =
					error instanceof BrowserMaintenanceError ||
					typeof error?.code === "string"
						? safeFailureCode(error.code)
						: "maintenance_failed";
				const update = statusUpdate(account, {
					state: "error",
					lastCheckAtMs: safeNow(clock),
					failureCode: code,
				});
				try {
					await publishState(account, update, code);
				} catch {
					safeOperationalError(onOperationalError, "state_update_failed");
				}
			}
			return { ready: false };
		} finally {
			removeDisplayFailure?.();
			if (job.signal)
				job.signal.removeEventListener("abort", cancelJob);
			await stopLeaseHeartbeat();
			await closeBrowserOnce();
			if (leased) {
				try {
					await client.releaseLease(account.id, owner);
				} catch {
					safeOperationalError(onOperationalError, "lease_release_failed");
				}
			}
		}
	}

	async function publishState(account, update, category) {
		await client.patchState(account.id, update);
		account.status = {
			credentialsConfigured: account.status.credentialsConfigured,
			state: update.state,
			lastCheckAtMs: update.lastCheckAtMs,
			lastCookieUpdateAtMs: update.lastCookieUpdateAtMs,
			lastAutoLoginAtMs: update.lastAutoLoginAtMs,
			failureCode: update.failureCode,
		};
		account.authFailureCount = update.authFailureCount;
		if (account.notificationState === update.state) return;
		try {
			const notified = await notifier?.notifyTransition({
				accountId: account.id,
				label: account.label,
				previousNotificationState: account.notificationState,
				stateUpdate: update,
				failureCategory: safeFailureCode(category),
			});
			if (notified === true) account.notificationState = update.state;
		} catch {
			safeOperationalError(onOperationalError, "notification_failed");
		}
	}

	return Object.freeze({
		enqueue: queue.enqueue,
		reserve: queue.reserve,
		isBusy: queue.isBusy,
		scan,
		waitForIdle: queue.waitForIdle,
		async start() {
			if (started || stopped) return;
			started = true;
			try {
				await scan();
			} catch {
				safeOperationalError(onOperationalError, "schedule_scan_failed");
			}
			arm();
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			if (timer !== null) clearTimer(timer);
			if (timerCycle) await timerCycle;
			await queue.stop();
		},
	});
}

function statusUpdate(account, overrides) {
	return {
		state: overrides.state ?? account.status.state,
		lastCheckAtMs:
			overrides.lastCheckAtMs === undefined
				? account.status.lastCheckAtMs
				: overrides.lastCheckAtMs,
		lastCookieUpdateAtMs:
			overrides.lastCookieUpdateAtMs === undefined
				? account.status.lastCookieUpdateAtMs
				: overrides.lastCookieUpdateAtMs,
		lastAutoLoginAtMs:
			overrides.lastAutoLoginAtMs === undefined
				? account.status.lastAutoLoginAtMs
				: overrides.lastAutoLoginAtMs,
		authFailureCount:
			overrides.authFailureCount === undefined
				? account.authFailureCount
				: overrides.authFailureCount,
		notificationState: account.notificationState,
		failureCode:
			overrides.failureCode === undefined
				? account.status.failureCode
				: overrides.failureCode,
	};
}

async function activePage(context) {
	const pages = typeof context?.pages === "function" ? context.pages() : [];
	if (pages?.[0]) return pages[0];
	if (typeof context?.newPage === "function") return context.newPage();
	throw new BrowserMaintenanceError("browser_unavailable");
}

async function restoreStoredSession(
	context,
	client,
	accountId,
	nowMs,
	dropRejectedStoredSession = false,
) {
	if (typeof client?.getSessionCookie !== "function") return false;
	if (
		typeof context?.cookies !== "function" ||
		typeof context?.addCookies !== "function"
	)
		throw new BrowserMaintenanceError("browser_unavailable");
	const current = await context.cookies("https://gemini.google.com");
	const has = (name) =>
		current.some(
			(cookie) =>
				cookie?.name === name &&
				typeof cookie.value === "string" &&
				cookie.value,
		);
	const complete = has("__Secure-1PSID") && has("__Secure-1PSIDTS");
	if (complete && !dropRejectedStoredSession) return true;
	const stored = await client.getSessionCookie(accountId);
	const value = (name) =>
		current.find((cookie) => cookie?.name === name)?.value || "";
	const matchesStored =
		value("__Secure-1PSID") === stored.psid &&
		value("__Secure-1PSIDTS") === stored.psidts;
	if (dropRejectedStoredSession && (!complete || matchesStored)) {
		if (typeof context.clearCookies !== "function")
			throw new BrowserMaintenanceError("browser_unavailable");
		await context.clearCookies({
			name: /^(?:__Secure-1PSID|__Secure-1PSIDTS)$/,
			domain: /(?:^|\.)google\.com$/,
		});
		return false;
	}
	if (complete) return true;
	const expires = Math.floor(nowMs / 1_000) + 30 * 24 * 60 * 60;
	await context.addCookies(
		["psid", "psidts"].map((field) => ({
			name: field === "psid" ? "__Secure-1PSID" : "__Secure-1PSIDTS",
			value: stored[field],
			domain: ".google.com",
			path: "/",
			secure: true,
			httpOnly: true,
			sameSite: "Lax",
			expires,
		})),
	);
	return true;
}

function attemptsToday(account, date) {
	return account.autoLoginAttemptDate === date ? account.autoLoginAttemptCount : 0;
}

function localDate(nowMs) {
	const date = new Date(nowMs);
	return [
		String(date.getFullYear()).padStart(4, "0"),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

function safeFailureCode(value) {
	return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)
		? value
		: "maintenance_failed";
}

function safeNow(clock) {
	const value = Number(clock());
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error("invalid browser scheduler clock");
	return value;
}

function validJob(input) {
	if (
		!input ||
		typeof input.accountId !== "string" ||
		!input.accountId ||
		!MODES.has(input.mode) ||
		(input.signal !== undefined &&
			typeof input.signal?.addEventListener !== "function")
	)
		throw new Error("invalid browser maintenance job");
	return { accountId: input.accountId, mode: input.mode, signal: input.signal };
}

function queuedJob(accountId, sequence) {
	return {
		accountId,
		sequence,
		mode: "scheduled",
		claims: [],
		controller: new AbortController(),
	};
}

function deferredClaim(job) {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { ...job, promise, resolve, reject, disposeAbort: null };
}

function recomputeMode(job) {
	job.mode = job.claims.reduce(
		(mode, claim) =>
			PRIORITY[claim.mode] > PRIORITY[mode] ? claim.mode : mode,
		"scheduled",
	);
}

function settleClaims(job, method, value) {
	for (const claim of job.claims.splice(0)) {
		claim.disposeAbort?.();
		claim[method](value);
	}
}

function safeOperationalError(callback, code) {
	try {
		callback(code);
	} catch {
		// Operational observation must not change maintenance state.
	}
}
