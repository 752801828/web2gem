import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { outputLine } from "../server/io.mjs";
import { commandAvailable, outputCommand, runCommand } from "./process.mjs";

export function smokeResourceNames(pid, nonce) {
	const suffix = `${Number(pid) || 0}-${String(nonce)
		.replace(/[^a-z0-9]/gi, "")
		.slice(0, 12)}`.toLowerCase();
	return Object.freeze({
		project: `web2gem-smoke-${suffix}`,
		webImage: `web2gem:smoke-${suffix}`,
		helperImage: `web2gem-browser-helper:smoke-${suffix}`,
	});
}

export function assertLoopbackPort(raw, expectedContainerPort) {
	const match = /^127\.0\.0\.1:(\d+)$/m.exec(String(raw).trim());
	if (!match || !Number(match[1]))
		throw new Error(
			`Docker smoke failed: ${expectedContainerPort} was not mapped to loopback`,
		);
	return Number(match[1]);
}

export function assertSmokeRedacted(logs, secrets) {
	const text = String(logs);
	for (const secret of secrets) {
		if (secret && text.includes(secret))
			throw new Error("Docker smoke failed: container logs exposed a secret");
	}
}

export function candidateCookiePath(accountId) {
	return `/internal/browser/accounts/${encodeURIComponent(accountId)}/candidate-cookie`;
}

export function helperRecreateArgs(composeArgs) {
	return [
		...composeArgs,
		"up",
		"-d",
		"--no-deps",
		"--force-recreate",
		"browser-helper",
	];
}

export function smokeComposeOverride({ mockScript, certDir, stateDir }) {
	const scriptMount = yamlString(
		`${dockerPath(mockScript)}:/smoke/mock.mjs:ro`,
	);
	const certMount = yamlString(`${dockerPath(certDir)}:/smoke/certs:ro`);
	const stateMount = yamlString(`${dockerPath(stateDir)}:/smoke/state`);
	return `services:
  web2gem:
    depends_on:
      smoke-upstream:
        condition: service_healthy
  browser-helper:
    depends_on:
      smoke-upstream:
        condition: service_healthy
    environment:
      NODE_EXTRA_CA_CERTS: "/smoke/certs/cert.pem"
    volumes:
      - ${certMount}
  smoke-upstream:
    image: "\${BROWSER_HELPER_IMAGE}"
    pull_policy: never
    command: ["node", "/smoke/mock.mjs"]
    environment:
      SMOKE_FEISHU_SIGNING_SECRET: "\${FEISHU_SIGNING_SECRET}"
      SMOKE_STATE_PATH: "/smoke/state/events.jsonl"
      HTTP_PROXY: ""
      HTTPS_PROXY: ""
      NO_PROXY: "*"
    volumes:
      - ${scriptMount}
      - ${certMount}
      - ${stateMount}
    networks:
      web2gem-egress:
      browser-egress:
        aliases:
          - open.feishu.cn
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 2s
      timeout: 2s
      retries: 30
`;
}

export function smokeMockServerSource() {
	return `import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const statePath = process.env.SMOKE_STATE_PATH;
const signingSecret = process.env.SMOKE_FEISHU_SIGNING_SECRET;
if (!statePath || !signingSecret) throw new Error("invalid smoke mock config");

const payload = [];
payload[14] = 1000;
payload[15] = [["model-pro", "Pro", "smoke capability"]];
payload[16] = [[21]];
const probeBody = JSON.stringify([["wrb.fr", "otAQ7b", JSON.stringify(payload)]]);

http.createServer((request, response) => void handle(request, response, false)).listen(8080, "0.0.0.0");
https.createServer({
  key: readFileSync("/smoke/certs/key.pem"),
  cert: readFileSync("/smoke/certs/cert.pem"),
}, (request, response) => void handle(request, response, true)).listen(8443, "0.0.0.0");

async function handle(request, response, secure) {
  try {
    const url = new URL(request.url || "/", secure ? "https://open.feishu.cn:8443" : "http://smoke-upstream:8080");
    if (!secure && url.pathname === "/health") return text(response, 200, "ok");
    if (!secure && url.pathname === "/app") {
      record({ kind: "gemini_app" });
      return html(response, '<html><script>"SNlM0e":"smoke-at-token"</script></html>');
    }
    if (!secure && url.pathname === "/_/BardChatUi/data/batchexecute") {
      await readBody(request);
      record({ kind: "gemini_probe", rpc: url.searchParams.get("rpcids") === "otAQ7b" });
      return jsonText(response, probeBody);
    }
    if (secure && url.pathname.startsWith("/open-apis/bot/v2/hook/")) {
      const body = JSON.parse(await readBody(request));
      const expected = createHmac("sha256", String(body.timestamp) + "\\n" + signingSecret).update("").digest("base64");
      if (!safeEqual(body.sign, expected)) return json(response, 403, { code: 1 });
      record({ kind: "feishu", signed: true });
      return json(response, 200, { code: 0 });
    }
    return text(response, 404, "not found");
  } catch {
    return json(response, 500, { code: 1 });
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) request.destroy(new Error("body too large"));
      else body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function safeEqual(left, right) {
  if (typeof left !== "string" || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function record(event) { appendFileSync(statePath, JSON.stringify(event) + "\\n", { encoding: "utf8", mode: 0o600 }); }
function text(response, status, body) { response.writeHead(status, { "content-type": "text/plain" }); response.end(body); }
function html(response, body) { response.writeHead(200, { "content-type": "text/html" }); response.end(body); }
function jsonText(response, body) { response.writeHead(200, { "content-type": "application/json" }); response.end(body); }
function json(response, status, body) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
`;
}

function yamlString(value) {
	return JSON.stringify(String(value));
}

function dockerPath(value) {
	return resolve(String(value)).replaceAll("\\", "/");
}

async function main() {
	if (!(await commandAvailable("docker"))) {
		outputLine("Docker smoke skipped: docker executable not found");
		return;
	}
	const daemon = await runCommand("docker", ["info"], {
		allowFailure: true,
		stdio: "ignore",
	});
	if (daemon.code !== 0)
		throw new Error("Docker smoke failed: Docker daemon is unavailable");

	const names = smokeResourceNames(process.pid, randomBytes(8).toString("hex"));
	const temp = await mkdtemp(join(tmpdir(), `${names.project}-`));
	const secretFile = join(temp, "web2gem_master_key");
	const mockScript = join(temp, "mock-upstream.mjs");
	const overrideFile = join(temp, "compose.smoke.yaml");
	const certDir = join(temp, "certs");
	const stateDir = join(temp, "state");
	const eventFile = join(stateDir, "events.jsonl");
	const masterKey = randomBytes(32).toString("base64");
	const apiKey = `api-${randomBytes(24).toString("hex")}`;
	const adminKey = `admin-${randomBytes(24).toString("hex")}`;
	const internalToken = `internal-${randomBytes(24).toString("hex")}`;
	const novncPassword = `vnc-${randomBytes(18).toString("hex")}`;
	const signingSecret = `sign-${randomBytes(24).toString("hex")}`;
	const webhookToken = randomBytes(20).toString("hex");
	const psid = randomBytes(24).toString("base64url");
	const oldPsidts = randomBytes(24).toString("base64url");
	const nextPsidts = randomBytes(24).toString("base64url");
	const compose = resolve("compose.yaml");
	const composeArgs = [
		"compose",
		"--project-name",
		names.project,
		"--file",
		compose,
		"--file",
		overrideFile,
	];
	const port = await freePort();
	let novncPort = await freePort();
	while (novncPort === port) novncPort = await freePort();
	const env = {
		...process.env,
		PORT: String(port),
		NOVNC_PORT: String(novncPort),
		WEB2GEM_IMAGE: names.webImage,
		BROWSER_HELPER_IMAGE: names.helperImage,
		WEB2GEM_MASTER_KEY_FILE: secretFile,
		API_KEYS: apiKey,
		ADMIN_KEY: adminKey,
		BROWSER_HELPER_INTERNAL_TOKEN: internalToken,
		NOVNC_PASSWORD: novncPassword,
		NOVNC_PUBLIC_URL: `http://127.0.0.1:${novncPort}/vnc.html`,
		BROWSER_CHECK_INTERVAL_SEC: "86400",
		BROWSER_CHECK_JITTER_SEC: "0",
		GEMINI_ORIGIN: "http://smoke-upstream:8080",
		FEISHU_WEBHOOK_URL: `https://open.feishu.cn:8443/open-apis/bot/v2/hook/${webhookToken}`,
		FEISHU_SIGNING_SECRET: signingSecret,
		HTTP_PROXY: "",
		HTTPS_PROXY: "",
		NO_PROXY: "*",
	};
	const safeCaptures = [];
	let composeAttempted = false;
	try {
		await Promise.all([
			mkdir(certDir, { recursive: true }),
			mkdir(stateDir, { recursive: true }),
		]);
		await writeFile(secretFile, `${masterKey}\n`, { mode: 0o600 });
		await writeFile(mockScript, smokeMockServerSource(), { mode: 0o600 });
		await writeFile(
			overrideFile,
			smokeComposeOverride({ mockScript, certDir, stateDir }),
			{ mode: 0o600 },
		);
		composeAttempted = true;
		await runCommand(
			"docker",
			[...composeArgs, "build", "web2gem", "browser-helper"],
			{ env },
		);
		await generateMockCertificate(names.helperImage, certDir);
		await runCommand(
			"docker",
			[...composeArgs, "up", "-d", "--no-build", "--wait"],
			{ env },
		);
		await assertHealthy(composeArgs, env, "web2gem");
		await assertHealthy(composeArgs, env, "browser-helper");
		const mappedNovncPort = assertLoopbackPort(
			await outputCommand(
				"docker",
				[...composeArgs, "port", "browser-helper", "6080"],
				{ env },
			),
			6080,
		);
		assert(mappedNovncPort === novncPort, "noVNC port mapping changed");
		await waitForHealth(`http://127.0.0.1:${port}/`);
		await waitForHealth(`http://127.0.0.1:${novncPort}/vnc.html`);
		const health = await fetch(`http://127.0.0.1:${port}/`);
		assert(health.status === 200, `health status ${health.status}`);
		assert(
			(await health.json()).status === "ok",
			"health payload did not report ok",
		);
		const authFailure = await fetch(`http://127.0.0.1:${port}/v1/models`);
		assert(
			authFailure.status === 401,
			`auth failure status ${authFailure.status}`,
		);

		const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		assert(
			models.status === 200,
			`authenticated models status ${models.status}`,
		);
		const emptyAccountPool = await fetch(
			`http://127.0.0.1:${port}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "gemini-3.1-pro",
					messages: [{ role: "user", content: "hello" }],
				}),
			},
		);
		assert(
			emptyAccountPool.status === 503,
			`empty account pool status ${emptyAccountPool.status}`,
		);
		assert(
			(await emptyAccountPool.json()).error?.code ===
				"no_available_gemini_account",
			"empty account pool did not return the availability error",
		);

		const imported = await fetch(`http://127.0.0.1:${port}/admin/accounts`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${adminKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "gemini",
				"__Secure-1PSID": psid,
				"__Secure-1PSIDTS": oldPsidts,
				label: "Smoke account",
			}),
		});
		const importedText = await imported.text();
		safeCaptures.push(importedText);
		assert(imported.status === 200, `account import status ${imported.status}`);
		const account = await waitForAdminAccount(port, adminKey);
		const candidate = await fetch(
			`http://127.0.0.1:${port}${candidateCookiePath(account.id)}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${internalToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					psid,
					psidts: nextPsidts,
					observedEmail: null,
				}),
			},
		);
		const candidateText = await candidate.text();
		safeCaptures.push(candidateText);
		assert(candidate.status === 200, `candidate status ${candidate.status}`);
		const candidateResult = JSON.parse(candidateText);
		assert(candidateResult.changed === true, "candidate cookie did not change");
		assert(candidateResult.state === "ready", "candidate did not become ready");
		const expectedCookieHash = createHash("sha256")
			.update(`__Secure-1PSID=${psid}; __Secure-1PSIDTS=${nextPsidts}`)
			.digest("hex");
		const candidateFacts = JSON.parse(
			(
				await outputCommand(
					"docker",
					[
						...composeArgs,
						"exec",
						"-T",
						"web2gem",
						"node",
						"-e",
						sqliteCandidateFactsScript(account.id),
					],
					{ env },
				)
			).trim(),
		);
		assert(
			candidateFacts.cookieHash === expectedCookieHash,
			"candidate cookie hash was not persisted",
		);
		assert(candidateFacts.modelId === "model-pro", "candidate model missing");
		const manualState = await fetch(
			`http://127.0.0.1:${port}/internal/browser/accounts/${encodeURIComponent(account.id)}/state`,
			{
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${internalToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					state: "manual_action_required",
					lastCheckAtMs: Date.now(),
					lastCookieUpdateAtMs: candidateResult.lastCookieUpdateAtMs,
					lastAutoLoginAtMs: null,
					authFailureCount: 0,
					notificationState: null,
					failureCode: "captcha",
				}),
			},
		);
		const manualText = await manualState.text();
		safeCaptures.push(manualText);
		assert(
			manualState.status === 200,
			`manual state status ${manualState.status}`,
		);
		await runCommand(
			"docker",
			[
				...composeArgs,
				"exec",
				"-T",
				"-e",
				`SMOKE_ACCOUNT_ID=${account.id}`,
				"browser-helper",
				"node",
				"--use-env-proxy",
				"--input-type=module",
				"-e",
				helperNotifierScript(),
			],
			{ env, stdio: "ignore" },
		);
		const eventsText = await readFile(eventFile, "utf8");
		safeCaptures.push(eventsText);
		const events = eventsText
			.trim()
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		assert(
			events.some((event) => event.kind === "gemini_probe" && event.rpc),
			"mock Gemini probe was not exercised",
		);
		assert(
			events.filter((event) => event.kind === "feishu" && event.signed)
				.length === 1,
			"mock Feishu did not receive exactly one signed notification",
		);

		const webContainerBefore = await serviceContainer(
			composeArgs,
			env,
			"web2gem",
		);
		const helperContainerBefore = await serviceContainer(
			composeArgs,
			env,
			"browser-helper",
		);
		await runCommand(
			"docker",
			[
				...composeArgs,
				"exec",
				"-T",
				"browser-helper",
				"node",
				"-e",
				"require('node:fs').writeFileSync('/profiles/.smoke-profile','ok')",
			],
			{ env, stdio: "ignore" },
		);
		await runCommand("docker", helperRecreateArgs(composeArgs), {
			env,
			stdio: "ignore",
		});
		await waitForServiceHealth(composeArgs, env, "browser-helper");
		assert(
			(await serviceContainer(composeArgs, env, "browser-helper")) !==
				helperContainerBefore,
			"helper force-recreate kept the old container",
		);
		assert(
			(await serviceContainer(composeArgs, env, "web2gem")) ===
				webContainerBefore,
			"helper restart recreated web2gem",
		);
		assert(
			(
				await outputCommand(
					"docker",
					[
						...composeArgs,
						"exec",
						"-T",
						"browser-helper",
						"node",
						"-e",
						"process.stdout.write(require('node:fs').readFileSync('/profiles/.smoke-profile','utf8'))",
					],
					{ env },
				)
			).trim() === "ok",
			"browser profile volume did not persist",
		);

		const sqliteWrite = [
			"const{DatabaseSync}=require('node:sqlite')",
			"const d=new DatabaseSync(process.env.SQLITE_PATH)",
			"d.prepare(\"INSERT OR REPLACE INTO gemini_pool_meta(key,value,updated_at_ms) VALUES('smoke_persistence','ok',1)\").run()",
			"d.close()",
		].join(";");
		await runCommand(
			"docker",
			[...composeArgs, "exec", "-T", "web2gem", "node", "-e", sqliteWrite],
			{ env, stdio: "ignore" },
		);
		await runCommand(
			"docker",
			[...composeArgs, "up", "-d", "--no-deps", "--force-recreate", "web2gem"],
			{ env, stdio: "ignore" },
		);
		await waitForServiceHealth(composeArgs, env, "web2gem");
		const sqliteRead = [
			"const{DatabaseSync}=require('node:sqlite')",
			"const d=new DatabaseSync(process.env.SQLITE_PATH,{readOnly:true})",
			"process.stdout.write(d.prepare(\"SELECT value FROM gemini_pool_meta WHERE key='smoke_persistence'\").get()?.value||'')",
			"d.close()",
		].join(";");
		assert(
			(
				await outputCommand(
					"docker",
					[...composeArgs, "exec", "-T", "web2gem", "node", "-e", sqliteRead],
					{ env },
				)
			).trim() === "ok",
			"SQLite volume did not persist",
		);

		const logs = await outputCommand(
			"docker",
			[...composeArgs, "logs", "--no-color"],
			{ env },
		);
		assertSmokeRedacted(`${logs}\n${safeCaptures.join("\n")}`, [
			masterKey,
			apiKey,
			adminKey,
			internalToken,
			novncPassword,
			signingSecret,
			webhookToken,
			psid,
			oldPsidts,
			nextPsidts,
		]);
		outputLine("Docker smoke check passed");
	} finally {
		if (composeAttempted)
			await runCommand("docker", [...composeArgs, "down", "--remove-orphans"], {
				env,
				allowFailure: true,
				stdio: "ignore",
			});
		for (const volume of [
			`${names.project}_web2gem-data`,
			`${names.project}_browser-profiles`,
		])
			await outputCommand("docker", ["volume", "rm", volume], {
				allowFailure: true,
			});
		for (const image of [names.webImage, names.helperImage])
			await outputCommand("docker", ["image", "rm", image], {
				allowFailure: true,
			});
		await rm(temp, { recursive: true, force: true });
	}
}

async function generateMockCertificate(helperImage, certDir) {
	await runCommand(
		"docker",
		[
			"run",
			"--rm",
			"--entrypoint",
			"openssl",
			"-v",
			`${dockerPath(certDir)}:/out`,
			helperImage,
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			"/out/key.pem",
			"-out",
			"/out/cert.pem",
			"-days",
			"1",
			"-subj",
			"/CN=open.feishu.cn",
			"-addext",
			"subjectAltName=DNS:open.feishu.cn",
		],
		{ stdio: "ignore" },
	);
}

async function waitForAdminAccount(port, adminKey) {
	let lastStatus = 0;
	for (let index = 0; index < 60; index += 1) {
		const response = await fetch(`http://127.0.0.1:${port}/admin/accounts`, {
			headers: { Authorization: `Bearer ${adminKey}` },
			signal: AbortSignal.timeout(2_000),
		});
		lastStatus = response.status;
		if (response.ok) {
			const body = await response.json();
			const account = body.items?.[0];
			if (
				account &&
				typeof account.id === "string" &&
				Number.isSafeInteger(account.status_checked_at_ms)
			)
				return account;
		}
		await delay(500);
	}
	throw new Error(
		`Docker smoke failed: imported account probe status ${lastStatus}`,
	);
}

function sqliteCandidateFactsScript(accountId) {
	return [
		"const{DatabaseSync}=require('node:sqlite')",
		"const d=new DatabaseSync(process.env.SQLITE_PATH,{readOnly:true})",
		`const id=${JSON.stringify(accountId)}`,
		"const a=d.prepare('SELECT cookie_hash FROM gemini_accounts WHERE id=?').get(id)",
		"const m=d.prepare('SELECT model_id FROM gemini_account_models WHERE account_id=? ORDER BY discovery_order LIMIT 1').get(id)",
		"process.stdout.write(JSON.stringify({cookieHash:a?.cookie_hash||null,modelId:m?.model_id||null}))",
		"d.close()",
	].join(";");
}

function helperNotifierScript() {
	return `const { loadBrowserHelperConfig } = await import('./browser-helper/config.mjs');
const { createWeb2gemClient } = await import('./browser-helper/web2gem-client.mjs');
const { createFeishuNotifier } = await import('./browser-helper/feishu.mjs');
const config = loadBrowserHelperConfig();
const client = createWeb2gemClient(config);
const notifier = createFeishuNotifier(config, { client });
const accountId = process.env.SMOKE_ACCOUNT_ID;
const current = (await client.listAccounts()).find(account => account.id === accountId);
if (!current) throw new Error('smoke account missing');
const stateUpdate = {
  state: 'manual_action_required',
  lastCheckAtMs: current.status.lastCheckAtMs,
  lastCookieUpdateAtMs: current.status.lastCookieUpdateAtMs,
  lastAutoLoginAtMs: current.status.lastAutoLoginAtMs,
  authFailureCount: current.authFailureCount,
  notificationState: current.notificationState,
  failureCode: 'captcha',
};
const first = await notifier.notifyTransition({
  accountId,
  label: current.label,
  previousNotificationState: current.notificationState,
  stateUpdate,
  failureCategory: 'captcha',
});
const refreshed = (await client.listAccounts()).find(account => account.id === accountId);
const second = await notifier.notifyTransition({
  accountId,
  label: current.label,
  previousNotificationState: refreshed?.notificationState ?? null,
  stateUpdate,
  failureCategory: 'captcha',
});
if (first !== true || second !== false) throw new Error('notification dedupe failed');
`;
}

async function serviceContainer(composeArgs, env, service) {
	const id = (
		await outputCommand("docker", [...composeArgs, "ps", "-q", service], {
			env,
		})
	).trim();
	assert(id, `${service} container is missing`);
	return id;
}

async function assertHealthy(composeArgs, env, service) {
	const id = await serviceContainer(composeArgs, env, service);
	const status = (
		await outputCommand(
			"docker",
			["inspect", "--format", "{{.State.Health.Status}}", id],
			{ env },
		)
	).trim();
	assert(status === "healthy", `${service} health status ${status}`);
}

async function waitForServiceHealth(composeArgs, env, service) {
	let last = "missing";
	for (let index = 0; index < 90; index += 1) {
		try {
			const id = await serviceContainer(composeArgs, env, service);
			last = (
				await outputCommand(
					"docker",
					["inspect", "--format", "{{.State.Health.Status}}", id],
					{ env, allowFailure: true },
				)
			).trim();
			if (last === "healthy") return;
		} catch {}
		await delay(1_000);
	}
	throw new Error(`Docker smoke failed: ${service} health status ${last}`);
}

async function waitForHealth(url) {
	let lastError = null;
	for (let index = 0; index < 60; index += 1) {
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(2_000),
			});
			if (response.ok) return;
			lastError = new Error(`health status ${response.status}`);
		} catch (error) {
			lastError = error;
		}
		await delay(500);
	}
	throw new Error(
		`Docker smoke failed: health did not become ready: ${lastError}`,
	);
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.unref();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close((error) => {
				if (error) reject(error);
				else if (address && typeof address === "object")
					resolvePort(address.port);
				else reject(new Error("Docker smoke failed: no free port"));
			});
		});
	});
}

function delay(ms) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(ok, message) {
	if (!ok) throw new Error(`Docker smoke failed: ${message}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main();
