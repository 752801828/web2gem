import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import http from "node:http";
import { Readable } from "node:stream";
import { profilePathForAccount } from "./chromium.mjs";
import { createPlaywrightPageAdapter } from "./google-login.mjs";

const MAX_BODY_BYTES = 64 * 1_024;
const ACCOUNT_ID = "([^/]+)";
const ROUTES = [
	{ method: "POST", pattern: new RegExp(`^/checks/${ACCOUNT_ID}$`), action: "check" },
	{
		method: "POST",
		pattern: new RegExp(`^/sessions/${ACCOUNT_ID}/open$`),
		action: "open",
	},
	{ method: "POST", pattern: /^\/sessions\/stop$/, action: "stop" },
	{
		method: "DELETE",
		pattern: new RegExp(`^/profiles/${ACCOUNT_ID}$`),
		action: "profile",
	},
];

export class ControlError extends Error {
	constructor(status, code) {
		super(String(code).replaceAll("_", " "));
		this.name = "ControlError";
		this.status = status;
		this.code = code;
	}
}

export function createControlRequestHandler(config, dependencies) {
	const expectedToken = secretDigest(config?.controlToken);
	const { scheduler, sessions, profiles } = dependencies || {};
	if (!scheduler || !sessions || !profiles)
		throw new Error("invalid browser control dependencies");

	return async function handle(request) {
		try {
			const url = new URL(request.url);
			if (url.search || url.hash) throw new ControlError(404, "not_found");
			if (url.pathname === "/health") {
				if (request.method !== "GET")
					throw new ControlError(405, "method_not_allowed");
				return jsonResponse(200, { status: "ok" });
			}
			if (!authorized(request.headers.get("authorization"), expectedToken))
				throw new ControlError(401, "unauthorized");
			const route = routeFor(url.pathname);
			if (!route) throw new ControlError(404, "not_found");
			if (route.method !== request.method)
				throw new ControlError(405, "method_not_allowed");
			await readEmptyJson(request);
			const accountId = route.encodedId
				? decodeAccountId(route.encodedId)
				: null;
			if (route.action === "check") {
				Promise.resolve(
					scheduler.enqueue({ accountId, mode: "manual_check" }),
				).catch(() => undefined);
			} else if (route.action === "open")
				await sessions.open(accountId, request.signal);
			else if (route.action === "stop") await sessions.stop();
			else await profiles.remove(accountId);
			return jsonResponse(200, { ok: true });
		} catch (error) {
			const safe =
				error instanceof ControlError
					? error
					: new ControlError(500, "internal_error");
			return jsonResponse(safe.status, { error: { code: safe.code } });
		}
	};
}

export function createVisibleSessionCoordinator(config, dependencies) {
	const { scheduler, novnc } = dependencies || {};
	const setTimer = dependencies?.setTimer || setTimeout;
	const clearTimer = dependencies?.clearTimer || clearTimeout;
	const setSubmissionTimer = dependencies?.setSubmissionTimer || setTimeout;
	const clearSubmissionTimer = dependencies?.clearSubmissionTimer || clearTimeout;
	const prepareVisiblePage =
		dependencies?.prepareVisiblePage ||
		(async (page) => {
			if (await createPlaywrightPageAdapter(page).sessionAuthenticated())
				return true;
			await page.goto("https://gemini.google.com/app", {
				waitUntil: "domcontentloaded",
			});
			return false;
		});
	const trackActivity = dependencies?.trackActivity || installPageActivityTracking;
	const waitForAuthentication =
		dependencies?.waitForAuthentication || (() => new Promise(() => {}));
	if (
		!scheduler ||
		!novnc ||
		!Number.isSafeInteger(config?.visibleIdleTimeoutSec) ||
		config.visibleIdleTimeoutSec < 1 ||
		!Number.isSafeInteger(config?.visibleSubmissionTimeoutSec ?? 180) ||
		(config.visibleSubmissionTimeoutSec ?? 180) < 1
	)
		throw new Error("invalid visible session configuration");
	let active = null;

	function armIdle(session) {
		if (session.timer !== null) clearTimer(session.timer);
		session.timer = setTimer(() => {
			session.timer = null;
			if (session.submitting) session.idleExpired = true;
			else session.stop.resolve();
		}, config.visibleIdleTimeoutSec * 1_000);
	}

	function armSubmissionWatchdog(session) {
		if (session.submissionTimer !== null)
			clearSubmissionTimer(session.submissionTimer);
		session.submissionTimer = setSubmissionTimer(() => {
			session.submissionTimer = null;
			session.submitting = false;
			if (session.idleExpired) session.stop.resolve();
			else armIdle(session);
		}, (config.visibleSubmissionTimeoutSec ?? 180) * 1_000);
	}

	function endSubmission(session) {
		if (session.submissionTimer !== null)
			clearSubmissionTimer(session.submissionTimer);
		session.submissionTimer = null;
		session.submitting = false;
		if (session.idleExpired) session.stop.resolve();
		else armIdle(session);
	}

	async function finalize(session) {
		if (session.timer !== null) clearTimer(session.timer);
		if (session.submissionTimer !== null)
			clearSubmissionTimer(session.submissionTimer);
		try {
			await session.cleanupActivity?.();
		} catch {
			// Activity cleanup cannot strand the display stack.
		}
		try {
			await novnc.stop();
		} finally {
			if (active === session) active = null;
		}
	}

	return Object.freeze({
		async open(accountId, signal) {
			validAccountId(accountId);
			if (signal?.aborted) throw new ControlError(499, "request_aborted");
			if (active) {
				if (active.accountId !== accountId)
					throw new ControlError(409, "visible_session_conflict");
				const callerAbort = abortRace(signal);
				try {
					const outcome = await Promise.race([
						active.ready.promise.then(() => "ready"),
						active.job?.then(() => "ended"),
						callerAbort.promise.then(() => "abort"),
					]);
					if (outcome === "ended")
						throw new ControlError(503, "visible_session_unavailable");
					if (outcome === "abort" || signal?.aborted)
						throw new ControlError(499, "request_aborted");
					return;
				} finally {
					callerAbort.dispose();
				}
			}
			const session = {
				accountId,
				ready: deferred(),
				stop: deferred(),
				jobReady: deferred(),
				job: null,
				timer: null,
				submissionTimer: null,
				submitting: false,
				idleExpired: false,
				cleanupActivity: null,
			};
			active = session;
			const callerAbort = abortRace(signal);
			try {
				const rawJob = Promise.resolve(
					scheduler.enqueue({ accountId, mode: "visible", signal }),
				);
				session.job = rawJob.finally(() => finalize(session));
				session.jobReady.resolve();
				const outcome = await Promise.race([
					session.ready.promise.then(() => "ready"),
					session.job.then(() => "ended"),
					callerAbort.promise.then(() => "abort"),
				]);
				if (outcome === "ended")
					throw new ControlError(503, "visible_session_unavailable");
				if (outcome === "abort" || signal?.aborted)
					throw new ControlError(499, "request_aborted");
			} catch (error) {
				session.stop.resolve();
				if (!session.job) {
					session.jobReady.resolve();
					await finalize(session);
				}
				else await session.job.catch(() => undefined);
				throw error;
			} finally {
				callerAbort.dispose();
			}
		},
		async beforeVisibleStart(accountId, signal) {
			const session = active;
			if (!session || session.accountId !== accountId || signal?.aborted)
				throw new Error("visible browser session cancelled");
			const started = await novnc.start();
			if (signal?.aborted) {
				await novnc.stop();
				throw new Error("visible browser session cancelled");
			}
			return started;
		},
		async hold(input, finalCheck) {
			const session = active;
			if (
				!session ||
				input?.mode !== "visible" ||
				input.accountId !== session.accountId
			)
				throw new Error("visible browser session is not active");
			const jobAbort = abortRace(input.signal);
			const authenticationObserver = new AbortController();
			session.cleanupActivity = await trackActivity(input.page, {
				activity() {
					if (active !== session || session.stop.settled) return;
					if (session.submitting) return;
					session.idleExpired = false;
					armIdle(session);
				},
				submissionStart() {
					if (active !== session || session.stop.settled) return;
					session.submitting = true;
					session.idleExpired = false;
					armIdle(session);
					armSubmissionWatchdog(session);
				},
				submissionEnd() {
					if (active !== session || session.stop.settled) return;
					endSubmission(session);
				},
			});
			try {
				let initiallyAuthenticated = false;
				const preparation = Promise.resolve(prepareVisiblePage(input.page)).then(
					(value) => {
						initiallyAuthenticated = value === true;
					},
				);
				const prepared = await Promise.race([
					preparation.then(() => "ready"),
					session.stop.promise.then(() => "stop"),
					jobAbort.promise.then(() => "abort"),
				]);
				if (prepared !== "ready")
					throw new Error("visible browser session cancelled");
				armIdle(session);
				session.ready.resolve();
				if (input.credentials) {
					const automatic = await finalCheck(input);
					if (automatic?.ok) return automatic;
				}
				const waits = [
					session.stop.promise.then(() => "stop"),
					jobAbort.promise.then(() => "abort"),
				];
				if (!initiallyAuthenticated)
					waits.push(
						Promise.resolve(
							waitForAuthentication(input.page, authenticationObserver.signal),
						).then(
							() => "authenticated",
							() => "observer_ended",
						),
					);
				let outcome = await Promise.race(waits);
				if (outcome === "observer_ended")
					outcome = await Promise.race([
						session.stop.promise.then(() => "stop"),
						jobAbort.promise.then(() => "abort"),
					]);
				if (outcome === "abort")
					throw input.signal?.reason instanceof Error
						? input.signal.reason
						: new Error("visible browser session aborted");
				return finalCheck({
					...input,
					credentials: undefined,
					beforeSubmit: undefined,
				});
			} finally {
				authenticationObserver.abort();
				jobAbort.dispose();
			}
		},
		async stop() {
			const session = active;
			if (!session) return;
			session.stop.resolve();
			await session.jobReady.promise;
			if (session.job) await session.job;
		},
		requestStop() {
			active?.stop.resolve();
		},
		isActive(accountId) {
			return Boolean(active && (accountId === undefined || active.accountId === accountId));
		},
		async waitForIdle() {
			if (active?.job) await active.job.catch(() => undefined);
		},
	});
}

export function createProfileStore(config, dependencies) {
	const profilesRoot = config?.profilesRoot || "/profiles";
	const stat = dependencies?.lstat || lstat;
	const remove = dependencies?.rm || rm;
	const reserve = dependencies?.reserve;
	if (typeof reserve !== "function")
		throw new Error("invalid browser profile store dependencies");
	return Object.freeze({
		async remove(accountId) {
			validAccountId(accountId);
			const release = reserve(accountId);
			if (!release) throw new ControlError(409, "profile_busy");
			try {
				const target = profilePathForAccount(accountId, profilesRoot);
				let metadata;
				try {
					metadata = await stat(target);
				} catch (error) {
					if (error?.code !== "ENOENT") throw error;
				}
				if (metadata?.isSymbolicLink())
					throw new ControlError(409, "profile_unsafe");
				await remove(target, { recursive: true, force: true, maxRetries: 0 });
			} finally {
				release();
			}
		},
	});
}

export function createHelperControlServer(config, dependencies = {}) {
	const handler = createControlRequestHandler(config, dependencies);
	const createServer = dependencies.createServer || http.createServer;
	const sleep = dependencies.sleep || delay;
	const drainTimeoutMs = dependencies.drainTimeoutMs || 5_000;
	const forceCloseTimeoutMs = dependencies.forceCloseTimeoutMs || 1_000;
	const server = createServer({ maxHeaderSize: 16 * 1_024 }, async (incoming, outgoing) => {
		const disconnected = new AbortController();
		const onAborted = () => disconnected.abort();
		const onClosed = () => {
			if (!outgoing.writableEnded) disconnected.abort();
		};
		incoming.once("aborted", onAborted);
		outgoing.once("close", onClosed);
		try {
			const request = incomingRequest(
				incoming,
				config.controlPort,
				disconnected.signal,
			);
			const response = await handler(request);
			if (!outgoing.destroyed && !outgoing.headersSent)
				outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			if (!outgoing.destroyed && !outgoing.writableEnded)
				outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch {
			try {
				if (!outgoing.destroyed && !outgoing.headersSent)
					outgoing.writeHead(500, { "content-type": "application/json" });
				if (!outgoing.destroyed && !outgoing.writableEnded)
					outgoing.end('{"error":{"code":"internal_error"}}');
			} catch {
				outgoing.destroy();
			}
		} finally {
			incoming.off("aborted", onAborted);
			outgoing.off("close", onClosed);
		}
	});
	server.maxHeadersCount = 100;
	server.headersTimeout = 10_000;
	server.requestTimeout = 15_000;
	let closing = null;
	const beginStop = () => {
		if (closing) return;
		closing = new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		closing.catch(() => undefined);
	};
	return Object.freeze({
		start() {
			return new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(config.controlPort, "0.0.0.0", () => {
					server.off("error", reject);
					resolve();
				});
			});
		},
		beginStop,
		async drain() {
			beginStop();
			let outcome = await settledWithin(closing, drainTimeoutMs, sleep);
			if (outcome.state === "failed") throw outcome.error;
			if (outcome.state === "settled") return;
			server.closeAllConnections?.();
			outcome = await settledWithin(closing, forceCloseTimeoutMs, sleep);
			if (outcome.state === "failed") throw outcome.error;
		},
	});
}

function routeFor(pathname) {
	for (const route of ROUTES) {
		const match = route.pattern.exec(pathname);
		if (match) return { ...route, encodedId: match[1] };
	}
	return null;
}

function secretDigest(value) {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value.length > 4_096
	)
		throw new Error("invalid browser control configuration");
	return createHash("sha256").update(value).digest();
}

function authorized(value, expected) {
	if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
	const supplied = value.slice(7);
	if (!supplied || supplied !== supplied.trim()) return false;
	return timingSafeEqual(createHash("sha256").update(supplied).digest(), expected);
}

async function readEmptyJson(request) {
	if (!request.body) return;
	if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || ""))
		throw new ControlError(415, "invalid_content_type");
	const reader = request.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let size = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				throw new ControlError(413, "request_too_large");
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		if (!text.trim()) return;
		const parsed = JSON.parse(text);
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed) ||
			Object.keys(parsed).length
		)
			throw new Error();
	} catch (error) {
		if (error instanceof ControlError) throw error;
		throw new ControlError(400, "invalid_json");
	}
}

function decodeAccountId(value) {
	let decoded;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		throw new ControlError(400, "invalid_account_id");
	}
	return validAccountId(decoded);
}

function validAccountId(value) {
	if (
		typeof value !== "string" ||
		!value ||
		Buffer.byteLength(value) > 256 ||
		/[\u0000-\u001f\u007f/\\]/.test(value) ||
		value === "." ||
		value === ".."
	)
		throw new ControlError(400, "invalid_account_id");
	return value;
}

function jsonResponse(status, body) {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

function deferred() {
	let resolve;
	let reject;
	let settled = false;
	const promise = new Promise((done, fail) => {
		resolve = (value) => {
			settled = true;
			done(value);
		};
		reject = (error) => {
			settled = true;
			fail(error);
		};
	});
	return {
		promise,
		resolve,
		reject,
		get settled() {
			return settled;
		},
	};
}

function abortRace(signal) {
	if (!signal) return { promise: new Promise(() => undefined), dispose() {} };
	if (signal.aborted)
		return { promise: Promise.resolve(), dispose() {} };
	let listener;
	const promise = new Promise((resolve) => {
		listener = resolve;
		signal.addEventListener("abort", listener, { once: true });
	});
	return {
		promise,
		dispose() {
			signal.removeEventListener("abort", listener);
		},
	};
}

function incomingRequest(incoming, port, signal) {
	const method = incoming.method || "GET";
	const hasBody =
		incoming.headers["transfer-encoding"] !== undefined ||
		(Number(incoming.headers["content-length"]) || 0) > 0;
	return new Request(`http://browser-helper:${port}${incoming.url || "/"}`, {
		method,
		headers: incoming.headers,
		signal,
		...(method === "GET" || method === "HEAD" || !hasBody
			? {}
			: { body: Readable.toWeb(incoming), duplex: "half" }),
	});
}

async function settledWithin(promise, milliseconds, sleep) {
	return Promise.race([
		promise.then(
			() => ({ state: "settled" }),
			(error) => ({ state: "failed", error }),
		),
		Promise.resolve(sleep(milliseconds)).then(() => ({ state: "timeout" })),
	]);
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function installPageActivityTracking(page, hooks) {
	const binding = "__web2gemBrowserActivity";
	await page.exposeBinding(binding, (_source, event) => {
		if (event === "activity") hooks.activity();
		else if (event === "submission-start") hooks.submissionStart();
	});
	const install = (name) => {
		if (globalThis.__web2gemBrowserActivityInstalled) return;
		globalThis.__web2gemBrowserActivityInstalled = true;
		const emit = (event) => void globalThis[name]?.(event);
		for (const event of ["pointerdown", "keydown", "input", "paste"])
			globalThis.addEventListener(event, () => emit("activity"), {
				capture: true,
				passive: true,
			});
		globalThis.addEventListener(
			"submit",
			() => emit("submission-start"),
			{ capture: true },
		);
	};
	await page.addInitScript(install, binding);
	await page.evaluate(install, binding);
	const submissionEnd = () => hooks.submissionEnd();
	page.on("domcontentloaded", submissionEnd);
	const navigated = (frame) => {
		if (frame === page.mainFrame()) hooks.submissionEnd();
	};
	page.on("framenavigated", navigated);
	return () => {
		page.off("domcontentloaded", submissionEnd);
		page.off("framenavigated", navigated);
	};
}
