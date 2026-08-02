import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import http from "node:http";
import { Readable } from "node:stream";
import { profilePathForAccount } from "./chromium.mjs";

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
			} else if (route.action === "open") await sessions.open(accountId);
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
	const prepareVisiblePage =
		dependencies?.prepareVisiblePage ||
		((page) => page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" }));
	if (
		!scheduler ||
		!novnc ||
		!Number.isSafeInteger(config?.visibleIdleTimeoutSec) ||
		config.visibleIdleTimeoutSec < 1
	)
		throw new Error("invalid visible session configuration");
	let active = null;

	async function finalize(session) {
		if (session.timer) clearTimer(session.timer);
		try {
			await novnc.stop();
		} finally {
			if (active === session) active = null;
		}
	}

	return Object.freeze({
		async open(accountId) {
			validAccountId(accountId);
			if (active)
				throw new ControlError(409, "visible_session_conflict");
			const session = {
				accountId,
				ready: deferred(),
				stop: deferred(),
				jobReady: deferred(),
				job: null,
				timer: null,
			};
			active = session;
			try {
				await novnc.start();
				const rawJob = Promise.resolve(
					scheduler.enqueue({ accountId, mode: "visible" }),
				);
				session.job = rawJob.finally(() => finalize(session));
				session.jobReady.resolve();
				await Promise.race([
					session.ready.promise,
					session.job.then(() => {
						throw new ControlError(503, "visible_session_unavailable");
					}),
				]);
			} catch (error) {
				session.stop.resolve();
				if (!session.job) {
					session.jobReady.resolve();
					await finalize(session);
				}
				else await session.job.catch(() => undefined);
				throw error;
			}
		},
		async hold(input, finalCheck) {
			const session = active;
			if (
				!session ||
				input?.mode !== "visible" ||
				input.accountId !== session.accountId
			)
				throw new Error("visible browser session is not active");
			await prepareVisiblePage(input.page);
			session.timer = setTimer(
				() => session.stop.resolve(),
				config.visibleIdleTimeoutSec * 1_000,
			);
			session.ready.resolve();
			const outcome = await Promise.race([
				session.stop.promise.then(() => "stop"),
				abortSignal(input.signal).then(() => "abort"),
			]);
			if (outcome === "abort")
				throw input.signal?.reason instanceof Error
					? input.signal.reason
					: new Error("visible browser session aborted");
			return finalCheck(input);
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
	const isBusy = dependencies?.isBusy || (() => false);
	return Object.freeze({
		async remove(accountId) {
			validAccountId(accountId);
			if (isBusy(accountId)) throw new ControlError(409, "profile_busy");
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
		},
	});
}

export function createHelperControlServer(config, dependencies = {}) {
	const handler = createControlRequestHandler(config, dependencies);
	const createServer = dependencies.createServer || http.createServer;
	const server = createServer(async (incoming, outgoing) => {
		try {
			const request = incomingRequest(incoming, config.controlPort);
			const response = await handler(request);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch {
			outgoing.writeHead(500, { "content-type": "application/json" });
			outgoing.end('{"error":{"code":"internal_error"}}');
		}
	});
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
		stop() {
			return new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
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
	const promise = new Promise((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function abortSignal(signal) {
	if (!signal) return new Promise(() => undefined);
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}

function incomingRequest(incoming, port) {
	const method = incoming.method || "GET";
	const hasBody =
		incoming.headers["transfer-encoding"] !== undefined ||
		(Number(incoming.headers["content-length"]) || 0) > 0;
	return new Request(`http://browser-helper:${port}${incoming.url || "/"}`, {
		method,
		headers: incoming.headers,
		...(method === "GET" || method === "HEAD" || !hasBody
			? {}
			: { body: Readable.toWeb(incoming), duplex: "half" }),
	});
}
