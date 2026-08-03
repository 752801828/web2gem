import type { Server } from "node:http";
import { connect as netConnect } from "node:net";
import { describe, test } from "vitest";
import { assertRuntimeConfig } from "../../src/config";
import app from "../../src/index";
import { isRecord, type UnknownRecord } from "../../src/shared/types";
import { assert } from "./assertions.js";

type DockerExecutionContext = {
	waitUntil(promise: Promise<unknown>): void;
};
type DockerRequest = {
	headers: Record<string, string | readonly string[] | undefined>;
	url?: string | null;
};
type DockerServerOptions = {
	host?: string;
	port?: number;
	env?: Record<string, unknown>;
	processEnv?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	secrets?: { path?: string };
	credentialCrypto?: BrowserCredentialCrypto;
	browserHelperClient?: BrowserHelperClient;
	app?: DockerApp;
};
type BrowserCredentialCrypto = {
	encrypt(accountId: string, credentials: unknown): Promise<unknown>;
	decrypt(accountId: string, encrypted: unknown): Promise<unknown>;
};
type BrowserHelperClient = {
	checkNow(accountId: string): Promise<void>;
	openVisible(accountId: string): Promise<{ url: string }>;
	stopVisible(): Promise<void>;
	deleteProfile(accountId: string): Promise<void>;
};
type DockerApp = {
	fetch(
		request: Request,
		env: Record<string, unknown>,
		context: DockerExecutionContext,
	): Response | Promise<Response>;
	assertRuntimeConfig?: (env: Record<string, unknown>) => void;
};
type Callable = (...args: never[]) => unknown;

async function importUnknown(specifier: string): Promise<unknown> {
	return import(specifier);
}

function moduleFunction<T extends Callable>(
	moduleValue: unknown,
	name: string,
): T {
	if (!isRecord(moduleValue) || typeof moduleValue[name] !== "function") {
		throw new TypeError(`module export ${name} must be a function`);
	}
	return moduleValue[name] as T;
}

const dockerServerModule = await importUnknown(
	new URL("../../server/docker-server.mjs", import.meta.url).href,
);
const createDockerServer = moduleFunction<
	(options?: DockerServerOptions) => Server
>(dockerServerModule, "createDockerServer");
const executionContext = moduleFunction<() => DockerExecutionContext>(
	dockerServerModule,
	"executionContext",
);
const requestHeaders = moduleFunction<
	(rawHeaders: readonly string[]) => Headers
>(dockerServerModule, "requestHeaders");
const requestUrl = moduleFunction<
	(request: DockerRequest, fallbackPort?: number) => string
>(dockerServerModule, "requestUrl");
const closeDockerStorage = moduleFunction<
	(sourceEnv?: Record<string, unknown>) => void
>(dockerServerModule, "closeDockerStorage");
const resolveDockerEnv = moduleFunction<
	(
		sourceEnv?: Record<string, unknown>,
		options?: {
			fetch?: typeof fetch;
			sqlite?: { migrationSql?: string; migrationPath?: string };
			secrets?: { path?: string };
			credentialCrypto?: BrowserCredentialCrypto;
			browserHelperClient?: BrowserHelperClient;
		},
	) => Record<string, unknown> & {
		ACCOUNT_DB?: { prepare(sql: string): unknown; close?: () => void };
		BROWSER_CREDENTIAL_CRYPTO?: BrowserCredentialCrypto;
		BROWSER_HELPER_CLIENT?: BrowserHelperClient;
	}
>(dockerServerModule, "resolveDockerEnv");
const startDockerServer = moduleFunction<
	(options?: DockerServerOptions) => Promise<Server>
>(dockerServerModule, "startDockerServer");

function listen(server: Server): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

async function withStderrWrite<T>(
	write: typeof process.stderr.write,
	run: () => T | PromiseLike<T>,
): Promise<T> {
	const original = process.stderr.write;
	process.stderr.write = write;
	try {
		return await run();
	} finally {
		process.stderr.write = original;
	}
}
function close(server: Server): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
}

function serverPort(server: Server): number {
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("expected an IP server address");
	}
	return address.port;
}

async function responseJsonRecord(response: Response): Promise<UnknownRecord> {
	const value: unknown = await response.json();
	if (!isRecord(value)) throw new TypeError("expected a JSON object response");
	return value;
}

describe("docker server", () => {
	test("provides background task tracking to the application", () => {
		assert.equal(typeof executionContext().waitUntil, "function");
	});
	test("normalizes raw Node headers and forwarded request URLs", async () => {
		const headers = requestHeaders([
			"X-Test",
			"one",
			"x-test",
			"two",
			"Host",
			"app.example",
		]);
		assert.equal(headers.get("x-test"), "one, two");
		assert.equal(headers.get("host"), "app.example");

		const url = requestUrl(
			{
				headers: {
					host: "internal.example",
					"x-forwarded-host": "api.example, proxy.example",
					"x-forwarded-proto": "https, http",
				},
				url: "/v1/models?q=1",
			},
			9999,
		);
		assert.equal(url, "https://api.example/v1/models?q=1");

		const fallbackUrl = requestUrl(
			{
				headers: {
					host: "internal.example",
					"x-forwarded-proto": ["https", "http"],
				},
				url: "/v1/models",
			},
			9999,
		);
		assert.equal(fallbackUrl, "https://internal.example/v1/models");
	});
	test("adapts Node HTTP requests to Application fetch with streamed bodies", async () => {
		const seen: {
			url?: string;
			method?: string;
			env?: Record<string, unknown>;
			body?: string;
		} = {};
		const server = createDockerServer({
			port: 0,
			env: { API_KEYS: "", CUSTOM_ENV: "ok" },
			app: {
				async fetch(request, env, ctx) {
					seen.url = request.url;
					seen.method = request.method;
					seen.env = env;
					seen.body = await request.text();
					ctx.waitUntil(Promise.resolve());
					return new Response(
						JSON.stringify({
							url: request.url,
							method: request.method,
							body: seen.body,
							env: env.CUSTOM_ENV,
						}),
						{
							status: 201,
							headers: {
								"content-type": "application/json",
								"x-adapter": "docker",
							},
						},
					);
				},
			},
		});
		await listen(server);
		try {
			const port = serverPort(server);
			const resp = await fetch(`http://127.0.0.1:${port}/v1/test`, {
				method: "POST",
				headers: {
					"content-type": "text/plain",
					"x-forwarded-proto": "https",
					host: "app.example",
				},
				body: "hello",
			});
			assert.equal(resp.status, 201);
			assert.equal(resp.headers.get("x-adapter"), "docker");
			const body = await responseJsonRecord(resp);
			assert.match(body.url, /^https:\/\/127\.0\.0\.1:\d+\/v1\/test$/);
			assert.equal(body.method, "POST");
			assert.equal(body.body, "hello");
			assert.equal(body.env, "ok");
			assert.equal(seen.body, "hello");
		} finally {
			await close(server);
		}
	});
	test("keeps empty non-GET request bodies absent", async () => {
		let bodyIsNull = false;
		const server = createDockerServer({
			env: {},
			app: {
				async fetch(request) {
					bodyIsNull = request.body === null;
					return new Response("ok");
				},
			},
		});
		await listen(server);
		try {
			const port = serverPort(server);
			const response = await fetch(`http://127.0.0.1:${port}/empty`, {
				method: "POST",
			});
			assert.equal(response.status, 200);
			assert.equal(await response.text(), "ok");
			assert.equal(bodyIsNull, true);
		} finally {
			await close(server);
		}
	});
	test("keeps headerless empty non-GET request bodies absent", async () => {
		let bodyIsNull = false;
		const server = createDockerServer({
			env: {},
			app: {
				async fetch(request) {
					bodyIsNull = request.body === null;
					return new Response("ok");
				},
			},
		});
		await listen(server);
		try {
			const port = serverPort(server);
			await new Promise<void>((resolve, reject) => {
				const socket = netConnect(port, "127.0.0.1");
				let response = "";
				socket.once("connect", () => {
					socket.write(
						"POST /empty HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
					);
				});
				socket.on("data", (chunk) => {
					response += chunk.toString();
				});
				socket.once("end", () => {
					assert.match(response, /200/);
					resolve();
				});
				socket.once("error", reject);
			});
			assert.equal(bodyIsNull, true);
		} finally {
			await close(server);
		}
	});
	test("does not stream response bodies for HEAD requests", async () => {
		const seen: { method?: string } = {};
		const server = createDockerServer({
			env: {},
			app: {
				async fetch(request) {
					seen.method = request.method;
					return new Response("body should not be sent", {
						status: 200,
						headers: {
							"x-head-check": "ok",
						},
					});
				},
			},
		});
		await listen(server);
		try {
			const port = serverPort(server);
			const resp = await fetch(`http://127.0.0.1:${port}/`, {
				method: "HEAD",
			});
			assert.equal(resp.status, 200);
			assert.equal(resp.headers.get("x-head-check"), "ok");
			assert.equal(await resp.text(), "");
			assert.equal(seen.method, "HEAD");
		} finally {
			await close(server);
		}
	});
	test("keeps representative Docker responses aligned with the Application entrypoint", async () => {
		const env = { API_KEYS: "required" };
		const server = createDockerServer({ env, app: app });
		await listen(server);
		try {
			const port = serverPort(server);
			for (const path of ["/", "/v1/models", "/missing"]) {
				const direct = await app.fetch(
					new Request(`http://127.0.0.1:${port}${path}`),
					env,
					{ waitUntil() {} },
				);
				const docker = await fetch(`http://127.0.0.1:${port}${path}`);
				assert.equal(docker.status, direct.status, path);
				assert.equal(
					docker.headers.get("content-type"),
					direct.headers.get("content-type"),
					path,
				);
				assert.equal(
					docker.headers.get("access-control-allow-origin"),
					direct.headers.get("access-control-allow-origin"),
					path,
				);
				assert.equal(await docker.text(), await direct.text(), path);
			}
		} finally {
			await close(server);
		}
	});
	test("propagates Docker client disconnects to the Application request signal", async () => {
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let markAborted: (reason: unknown) => void = () => {};
		const aborted = new Promise<unknown>((resolve) => {
			markAborted = resolve;
		});
		const server = createDockerServer({
			env: {},
			app: {
				async fetch(request) {
					markStarted();
					request.signal.addEventListener(
						"abort",
						() => markAborted(request.signal.reason),
						{ once: true },
					);
					await aborted;
					return new Response("aborted");
				},
			},
		});
		await listen(server);
		try {
			const port = serverPort(server);
			const controller = new AbortController();
			const response = fetch(`http://127.0.0.1:${port}/slow`, {
				signal: controller.signal,
			});
			await started;
			controller.abort();
			await assert.rejects(() => response, /abort/i);
			const reason = await aborted;
			assert.match(String(reason), /docker client disconnected/);
		} finally {
			await close(server);
		}
	});
	test("returns generic JSON errors for adapter failures", async () => {
		const server = createDockerServer({
			env: {},
			app: {
				async fetch() {
					throw new Error("boom");
				},
			},
		});
		await listen(server);
		const loggedErrors: string[] = [];
		await withStderrWrite(
			(chunk: string | Uint8Array) => {
				loggedErrors.push(String(chunk));
				return true;
			},
			async () => {
				try {
					const port = serverPort(server);
					const resp = await fetch(`http://127.0.0.1:${port}/`);
					assert.equal(resp.status, 500);
					assert.match(
						resp.headers.get("content-type"),
						/^application\/json\b/,
					);
					assert.deepEqual(await resp.json(), {
						error: { message: "internal server error" },
					});
				} finally {
					await close(server);
				}
			},
		);
		assert.equal(loggedErrors.length, 1);
		assert.match(loggedErrors[0], /boom/);
	});
	test("always injects local SQLite storage", async () => {
		const sqliteEnv = resolveDockerEnv(
			{ SQLITE_PATH: ":memory:" },
			{
				sqlite: {
					migrationSql:
						"CREATE TABLE IF NOT EXISTS local_test (id INTEGER PRIMARY KEY);",
				},
				secrets: { path: "missing-browser-master-key" },
			},
		);
		assert.equal(typeof sqliteEnv.ACCOUNT_DB?.prepare, "function");
		closeDockerStorage(sqliteEnv);
	});
	test("injects only an opaque credential binding when supplied", () => {
		const credentialCrypto: BrowserCredentialCrypto = {
			async encrypt() {
				return {};
			},
			async decrypt() {
				return {};
			},
		};
		const withoutSecret = resolveDockerEnv(
			{ SQLITE_PATH: ":memory:" },
			{
				sqlite: { migrationSql: "SELECT 1;" },
				secrets: { path: "missing-browser-master-key" },
			},
		);
		assert.equal(withoutSecret.BROWSER_CREDENTIAL_CRYPTO, undefined);
		closeDockerStorage(withoutSecret);

		const withBinding = resolveDockerEnv(
			{ SQLITE_PATH: ":memory:" },
			{
				sqlite: { migrationSql: "SELECT 1;" },
				secrets: { path: "missing-browser-master-key" },
				credentialCrypto,
			},
		);
		assert.equal(withBinding.BROWSER_CREDENTIAL_CRYPTO, credentialCrypto);
		assert.equal("BROWSER_MASTER_KEY" in withBinding, false);
		assert.equal("BROWSER_HELPER_CLIENT" in withBinding, false);
		closeDockerStorage(withBinding);
	});
	test("injects only an opaque browser helper client when supplied", () => {
		const browserHelperClient: BrowserHelperClient = {
			async checkNow() {},
			async openVisible() {
				return { url: "http://127.0.0.1:6080/vnc.html" };
			},
			async stopVisible() {},
			async deleteProfile() {},
		};
		const resolved = resolveDockerEnv(
			{ SQLITE_PATH: ":memory:" },
			{
				sqlite: { migrationSql: "SELECT 1;" },
				secrets: { path: "missing-browser-master-key" },
				browserHelperClient,
			},
		);
		assert.equal(resolved.BROWSER_HELPER_CLIENT, browserHelperClient);
		assert.equal("NOVNC_PUBLIC_URL" in resolved, false);
		closeDockerStorage(resolved);
	});
	test("rejects invalid runtime config before the Docker server listens", async () => {
		await assert.rejects(
			() =>
				startDockerServer({
					port: 0,
					env: { LOG_REQUESTS: "yes" },
					app: { ...app, assertRuntimeConfig },
				}),
			/LOG_REQUESTS must be true or false/,
		);
		const server = await startDockerServer({
			host: "127.0.0.1",
			port: 0,
			env: {},
			app: {
				async fetch() {
					return new Response("ok");
				},
			},
		});
		try {
			await new Promise<void>((resolve) => {
				if (server.listening) resolve();
				else server.once("listening", resolve);
			});
			assert.equal(server.listening, true);
		} finally {
			await close(server);
		}
	});
});
