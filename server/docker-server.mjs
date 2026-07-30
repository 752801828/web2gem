import http from "node:http";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { errorLine, outputLine } from "./io.mjs";
import { createSqliteBindingFromEnv } from "./sqlite-binding.mjs";

const port = Number(process.env.PORT || 52389);
const host = process.env.HOST || "0.0.0.0";
const env = { ...process.env };
let defaultAppModulePromise = null;
let defaultResolvedEnv = null;

export function requestHeaders(rawHeaders) {
	const headers = new Headers();
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const name = rawHeaders[i];
		const value = rawHeaders[i + 1];
		if (name && value !== undefined) headers.append(name, value);
	}
	return headers;
}

export function requestUrl(req, fallbackPort = port) {
	const scheme =
		firstForwardedHeaderValue(req.headers["x-forwarded-proto"]) || "http";
	const forwardedHost = firstForwardedHeaderValue(
		req.headers["x-forwarded-host"],
	);
	const authority =
		forwardedHost ||
		firstForwardedHeaderValue(req.headers.host) ||
		`localhost:${fallbackPort}`;
	return `${scheme}://${authority}${req.url || "/"}`;
}

function firstForwardedHeaderValue(value) {
	const raw = Array.isArray(value) ? value[0] : value;
	return String(raw || "")
		.split(",")[0]
		.trim();
}

export function executionContext() {
	const pending = new Set();
	return {
		waitUntil(promise) {
			const p = Promise.resolve(promise).catch((err) => {
				errorLine("waitUntil failed:", err);
			});
			pending.add(p);
			p.finally(() => pending.delete(p));
		},
	};
}

export function resolveDockerEnv(sourceEnv = process.env, options = {}) {
	const nextEnv = { ...sourceEnv };
	nextEnv.ACCOUNT_DB = createSqliteBindingFromEnv(sourceEnv, options.sqlite);
	return nextEnv;
}

export async function handleDockerRequest(req, res, options = {}) {
	const appImpl = options.app || (await defaultApp());
	const requestEnv = options.env || defaultDockerEnv();
	const fallbackPort = Number(options.port || port);
	const method = req.method || "GET";
	const abortController = new AbortController();
	const abortRequest = () => {
		if (!abortController.signal.aborted)
			abortController.abort(new Error("docker client disconnected"));
	};
	const abortOnResponseClose = () => {
		if (!res.writableEnded) abortRequest();
	};
	req.once("aborted", abortRequest);
	res.once("close", abortOnResponseClose);
	if (req.aborted) abortRequest();
	const init = {
		method,
		headers: requestHeaders(req.rawHeaders),
		signal: abortController.signal,
	};

	if (method !== "GET" && method !== "HEAD") {
		init.body = Readable.toWeb(req);
		init.duplex = "half";
	}

	try {
		const request = new Request(requestUrl(req, fallbackPort), init);
		const response = await appImpl.fetch(
			request,
			requestEnv,
			executionContext(),
		);

		res.statusCode = response.status;
		response.headers.forEach((value, key) => {
			res.setHeader(key, value);
		});

		if (!response.body || method === "HEAD") {
			res.end();
			return;
		}

		const body = Readable.fromWeb(response.body);
		body.pipe(res);
		await finished(res);
	} catch (error) {
		if (abortController.signal.aborted) return;
		throw error;
	} finally {
		req.off("aborted", abortRequest);
		res.off("close", abortOnResponseClose);
	}
}

function defaultDockerEnv() {
	if (!defaultResolvedEnv) defaultResolvedEnv = resolveDockerEnv(env);
	return defaultResolvedEnv;
}

async function defaultApp() {
	const mod = await defaultAppModule();
	return mod.default || mod;
}

async function defaultAppModule() {
	if (!defaultAppModulePromise)
		defaultAppModulePromise = import("../dist/app.js");
	return defaultAppModulePromise;
}

export function createDockerServer(options = {}) {
	const serverOptions = options.env
		? options
		: {
				...options,
				env: resolveDockerEnv(options.processEnv || process.env, {
					fetch: options.fetch,
				}),
			};
	const server = http.createServer((req, res) => {
		handleDockerRequest(req, res, serverOptions).catch((err) => {
			errorLine("request failed:", err);
			if (!res.headersSent) {
				res.statusCode = 500;
				res.setHeader("content-type", "application/json; charset=utf-8");
			}
			res.end(JSON.stringify({ error: { message: "internal server error" } }));
		});
	});
	server.once("close", () => closeDockerStorage(serverOptions.env));
	return server;
}

export function closeDockerStorage(sourceEnv) {
	const binding = sourceEnv?.ACCOUNT_DB;
	if (binding && typeof binding.close === "function") binding.close();
	if (sourceEnv === defaultResolvedEnv) defaultResolvedEnv = null;
}

export async function startDockerServer(options = {}) {
	const usesDefaultApp = !options.app;
	const resolvedEnv =
		options.env ||
		resolveDockerEnv(options.processEnv || process.env, {
			fetch: options.fetch,
		});
	let app = options.app;
	if (!app) {
		const mod = await defaultAppModule();
		app = mod.default || mod;
	}
	if (usesDefaultApp && typeof app.assertRuntimeConfig !== "function")
		throw new Error("application bundle is missing assertRuntimeConfig");
	if (typeof app.assertRuntimeConfig === "function")
		app.assertRuntimeConfig(resolvedEnv);
	const server = createDockerServer({ ...options, env: resolvedEnv, app });
	const listenPort = Number(options.port || port);
	const listenHost = options.host || host;
	server.listen(listenPort, listenHost, () => {
		outputLine(`web2gem listening on http://${listenHost}:${listenPort}`);
	});
	return server;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const server = await startDockerServer();
	let shuttingDown = false;
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		server.close((error) => {
			if (error) {
				errorLine("shutdown failed:", error);
				process.exitCode = 1;
			}
		});
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
}
