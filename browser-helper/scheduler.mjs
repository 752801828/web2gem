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
		if (reservations.has(job.accountId)) return Promise.resolve({ skipped: true });
		if (
			active?.accountId === job.accountId &&
			PRIORITY[job.mode] <= PRIORITY[active.mode]
		)
			return active.promise;
		let queued = pending.get(job.accountId);
		if (!queued) {
			queued = deferredJob(job, sequence++);
			pending.set(job.accountId, queued);
		} else if (PRIORITY[job.mode] > PRIORITY[queued.mode]) queued.mode = job.mode;
		startWorker();
		return queued.promise;
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
				const result = await handler({ accountId: next.accountId, mode: next.mode });
				next.resolve(result);
			} catch (error) {
				next.reject(error);
			} finally {
				active = null;
			}
		}
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
			for (const job of pending.values()) job.resolve({ skipped: true });
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
			const context = await (job.mode === "visible"
				? browser.startVisible(account.id)
				: browser.startHeadless(account.id));
			opened = true;
			assertLeaseActive();
			const page = await activePage(context);
			let result = await runLogin({
				accountId: account.id,
				page,
				mode: job.mode,
				signal: jobAbort.signal,
				credentials: undefined,
				nowSeconds: Math.floor(nowMs / 1_000),
				serverDate: client.serverDate,
				maxClockSkewSec: config.maxClockSkewSec,
			});
			assertLeaseActive();
			let autoLoginAtMs = account.status.lastAutoLoginAtMs;
			if (!result.ok && result.code === "login_failed" && job.mode !== "visible") {
				const canAttempt =
					account.status.credentialsConfigured &&
					account.status.state !== "manual_action_required" &&
					config.autoLoginMaxAttemptsPerDay > 0 &&
					attemptsToday(account, localDate(nowMs)) <
						config.autoLoginMaxAttemptsPerDay;
				if (canAttempt) {
					const date = localDate(nowMs);
					const envelope = await client.getEncryptedCredentials(account.id);
					const credentials = decryptCredentials(account.id, envelope);
					result = await runLogin({
						accountId: account.id,
						page,
						mode: job.mode,
						signal: jobAbort.signal,
						credentials,
						nowSeconds: Math.floor(nowMs / 1_000),
						serverDate: client.serverDate,
						maxClockSkewSec: config.maxClockSkewSec,
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
				}
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
			if (leased && !leaseLost) {
				const code =
					error instanceof BrowserMaintenanceError
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
		!MODES.has(input.mode)
	)
		throw new Error("invalid browser maintenance job");
	return { accountId: input.accountId, mode: input.mode };
}

function deferredJob(job, sequence) {
	let resolve;
	let reject;
	const promise = new Promise((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { ...job, sequence, promise, resolve, reject };
}

function safeOperationalError(callback, code) {
	try {
		callback(code);
	} catch {
		// Operational observation must not change maintenance state.
	}
}
