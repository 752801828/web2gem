import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "vitest";
import { CONFIG_ENV_KEYS } from "../../src/config/spec";
import { isRecord, type UnknownRecord } from "../../src/shared/types";
import { assert } from "./assertions.js";

type CoverageMetric = {
	total: number;
	covered: number;
	skipped: number;
	pct: number;
};
type CoverageEntry = {
	lines: CoverageMetric;
	statements: CoverageMetric;
	functions: CoverageMetric;
	branches: CoverageMetric;
};
type CoverageSummary = Record<string, CoverageEntry>;
type ScriptResult = {
	code: number;
	stdout: string;
	stderr: string;
};
type ExecutableResult = ScriptResult & { missing: boolean };
type AsyncPathCallback = (path: string) => Promise<void>;
type AsyncDirCallback = (path: string) => Promise<void>;

const DOCKER_ONLY_ENV_KEYS = [
	"PORT",
	"WEB2GEM_IMAGE",
	"BROWSER_HELPER_IMAGE",
	"WEB2GEM_MASTER_KEY_FILE",
	"SQLITE_PATH",
	"SQLITE_BUSY_TIMEOUT_MS",
	"NOVNC_PORT",
	"BROWSER_HELPER_INTERNAL_TOKEN",
	"NOVNC_PASSWORD",
	"NOVNC_PUBLIC_URL",
	"FEISHU_WEBHOOK_URL",
	"FEISHU_SIGNING_SECRET",
	"BROWSER_CHECK_INTERVAL_SEC",
	"BROWSER_CHECK_JITTER_SEC",
	"BROWSER_VISIBLE_IDLE_TIMEOUT_SEC",
	"BROWSER_VISIBLE_SUBMISSION_TIMEOUT_SEC",
	"BROWSER_AUTLOGIN_MAX_ATTEMPTS_PER_DAY",
	"BROWSER_MAX_CLOCK_SKEW_SEC",
];
function coverageEntry(linePct = 100, branchPct = 100): CoverageEntry {
	return {
		lines: { total: 100, covered: linePct, skipped: 0, pct: linePct },
		statements: { total: 100, covered: linePct, skipped: 0, pct: linePct },
		functions: { total: 100, covered: 100, skipped: 0, pct: 100 },
		branches: { total: 100, covered: branchPct, skipped: 0, pct: branchPct },
	};
}
function fullCoverageSummary(): CoverageSummary {
	return {
		total: coverageEntry(),
		"src/admin-ui/logic.ts": coverageEntry(),
		"src/attachments/plan.ts": coverageEntry(),
		"src/completion/ports.ts": coverageEntry(),
		"src/config/index.ts": coverageEntry(),
		"src/gemini/accounts/pool.ts": coverageEntry(),
		"src/gemini/app-page.ts": coverageEntry(),
		"src/gemini/completion-provider.ts": coverageEntry(),
		"src/gemini/index.ts": coverageEntry(),
		"src/gemini/client/index.ts": coverageEntry(),
		"src/gemini/client/parse-parts.ts": coverageEntry(),
		"src/gemini/transport/http.ts": coverageEntry(),
		"src/gemini/uploads/execute.ts": coverageEntry(),
		"src/http/core/json.ts": coverageEntry(),
		"src/http/admin/gemini-accounts.ts": coverageEntry(),
		"src/http/google/handlers.ts": coverageEntry(),
		"src/http/openai/chat.ts": coverageEntry(),
		"src/http/openai/completion-finalize.ts": coverageEntry(),
		"src/http/openai/responses.ts": coverageEntry(),
		"src/http/openai/responses-stream.ts": coverageEntry(),
		"src/http/stream/coalescer.ts": coverageEntry(),
		"src/models/index.ts": coverageEntry(),
		"src/promptcompat/message-model.ts": coverageEntry(),
		"src/promptcompat/prompt.ts": coverageEntry(),
		"src/promptcompat/attachment-inputs.ts": coverageEntry(),
		"src/promptcompat/google.ts": coverageEntry(),
		"src/promptcompat/responses.ts": coverageEntry(),
		"src/promptcompat/token-accounting.ts": coverageEntry(),
		"src/shared/text-metrics.ts": coverageEntry(),
		"src/toolcall/parse.ts": coverageEntry(),
		"src/completion/structured-output.ts": coverageEntry(),
		"src/toolcall/sieve.ts": coverageEntry(),
	};
}
async function withCoverageSummary(
	summary: CoverageSummary,
	run: AsyncPathCallback,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "gemini-coverage-"));
	try {
		const summaryPath = join(dir, "coverage-summary.json");
		await writeFile(summaryPath, JSON.stringify(summary), "utf8");
		await run(summaryPath);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
async function withTempFile(
	filename: string,
	body: string | Uint8Array,
	run: AsyncPathCallback,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "gemini-script-"));
	try {
		const path = join(dir, filename);
		await writeFile(path, body, "utf8");
		await run(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
async function withTempDir(run: AsyncDirCallback): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "gemini-script-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
function runNodeScript(
	script: string,
	arg: string | null,
	env: Readonly<Record<string, string | undefined>> = {},
	cwd = process.cwd(),
): Promise<ScriptResult> {
	return new Promise<ScriptResult>((done) => {
		const args = arg == null ? [script] : [script, arg];
		execFile(
			process.execPath,
			args,
			{ cwd, env: { ...process.env, ...env } },
			(error, stdout, stderr) => {
				done({
					code: error && typeof error.code === "number" ? error.code : 0,
					stdout,
					stderr,
				});
			},
		);
	});
}
function runExecutable(
	executable: string,
	args: readonly string[],
	unsetEnv: readonly string[] = [],
): Promise<ExecutableResult> {
	return new Promise<ExecutableResult>((done) => {
		const env = { ...process.env };
		for (const key of unsetEnv) delete env[key];
		execFile(
			executable,
			[...args],
			{ cwd: process.cwd(), env },
			(error, stdout, stderr) => {
				const code = (error as NodeJS.ErrnoException | null)?.code;
				done({
					code: typeof code === "number" ? code : error ? -1 : 0,
					missing: code === "ENOENT",
					stdout,
					stderr,
				});
			},
		);
	});
}

function deterministicBytes(length: number): Buffer {
	let state = 0x6d2b79f5;
	const bytes = Buffer.alloc(length);
	for (let index = 0; index < length; index++) {
		state = Math.imul(state ^ (state >>> 15), 1 | state);
		state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
		bytes[index] = (state ^ (state >>> 14)) & 0xff;
	}
	return bytes;
}
function parseEnvExampleKeys(source: string): Set<string> {
	const keys = new Set<string>();
	for (const line of source.split(/\r?\n/)) {
		const match = /^([A-Z0-9_]+)=/.exec(line.trim());
		if (match?.[1]) keys.add(match[1]);
	}
	return keys;
}
function parseComposeEnvironmentKeys(source: string): Set<string> {
	const keys = new Set<string>();
	for (const line of source.split(/\r?\n/)) {
		const match = /^\s{6}([A-Z0-9_]+):/.exec(line);
		if (match?.[1]) keys.add(match[1]);
	}
	return keys;
}
function parseComposeVariableReferences(source: string): Set<string> {
	const keys = new Set<string>();
	for (const match of source.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)) {
		if (match[1]) keys.add(match[1]);
	}
	return keys;
}
function composeServiceBlock(source: string, service: string): string {
	const match = new RegExp(
		`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\r?$|^[a-z]|(?![\\s\\S]))`,
		"m",
	).exec(source);
	if (!match?.[0]) throw new Error(`missing Compose service ${service}`);
	return match[0];
}
function missingKeys(
	expected: readonly string[],
	actual: ReadonlySet<string>,
): string[] {
	return expected.filter((key) => !actual.has(key));
}

function requiredRecord(value: unknown, label: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	return value;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function parseIgnorePatterns(source: string): string[] {
	return source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
}

async function readBothReadmes(): Promise<readonly [string, string]> {
	return Promise.all([
		readFile("README.md", "utf8"),
		readFile("README.zh.md", "utf8"),
	]);
}

function typeScriptDirective(suffix: string): string {
	return ["@", "ts-", suffix].join("");
}

type ScriptCase = {
	name: string;
	code: number;
	stdout?: readonly RegExp[];
	stderr?: readonly RegExp[];
};

async function assertScriptCase(
	result: ScriptResult,
	scriptCase: ScriptCase,
): Promise<void> {
	assert.equal(result.code, scriptCase.code, scriptCase.name);
	for (const pattern of scriptCase.stdout || []) {
		assert.match(result.stdout, pattern, scriptCase.name);
	}
	for (const pattern of scriptCase.stderr || []) {
		assert.match(result.stderr, pattern, scriptCase.name);
	}
}

describe("quality scripts", () => {
	test("enforces type-suppression accept and reject paths", async () => {
		const accepted = await runNodeScript("scripts/check-test-types.mjs", null);
		assert.equal(accepted.code, 0);
		assert.match(accepted.stdout, /type suppression check passed/);

		await withTempDir(async (dir) => {
			const suffixes = ["nocheck", "ignore", "expect-error"];
			const fixture = join(dir, "fixture.ts");
			const source = suffixes
				.map((suffix) => `// ${typeScriptDirective(suffix)}`)
				.join("\n");
			await writeFile(fixture, source, "utf8");
			const rejected = await runNodeScript("scripts/check-test-types.mjs", dir);
			assert.equal(rejected.code, 1);
			const displayFixture = relative(process.cwd(), fixture).replaceAll(
				"\\",
				"/",
			);
			for (const [index, suffix] of suffixes.entries()) {
				assert.equal(
					rejected.stderr.includes(
						`- ${displayFixture}:${index + 1}: ${typeScriptDirective(suffix)}`,
					),
					true,
				);
			}
		});
	});
	test("enforces coverage summary gates for required source targets", async () => {
		const cases: ReadonlyArray<
			ScriptCase & { mutate?: (summary: CoverageSummary) => void }
		> = [
			{
				name: "accepts line and branch gates",
				code: 0,
				stdout: [/Coverage gates passed/],
			},
			{
				name: "ignores third-party coverage",
				mutate: (summary) => {
					summary["node_modules/example/index.mjs"] = coverageEntry(0, 0);
				},
				code: 0,
				stdout: [/src: 100\.00% lines/],
			},
			{
				name: "rejects below branch gates",
				mutate: (summary) => {
					const sieveCoverage = summary["src/toolcall/sieve.ts"];
					if (!sieveCoverage) throw new Error("missing sieve coverage fixture");
					sieveCoverage.branches.covered = 54;
				},
				code: 1,
				stderr: [/Coverage gate failed/, /src\/toolcall/],
			},
			{
				name: "rejects missing required target data",
				mutate: (summary) => {
					for (const key of Object.keys(summary)) {
						if (key.startsWith("src/http/openai/")) delete summary[key];
					}
				},
				code: 1,
				stderr: [/missing lines coverage data/, /src\/http\/openai/],
			},
			{
				name: "rejects completion provider file gates",
				mutate: (summary) => {
					summary["src/gemini/completion-provider.ts"] = coverageEntry(94, 84);
				},
				code: 1,
				stderr: [
					/src\/gemini\/completion-provider\.ts/,
					/94\.00% lines/,
					/84\.00% branches/,
				],
			},
		];
		for (const coverageCase of cases) {
			const summary = fullCoverageSummary();
			coverageCase.mutate?.(summary);
			await withCoverageSummary(summary, async (summaryPath) => {
				await assertScriptCase(
					await runNodeScript("scripts/check-coverage.mjs", summaryPath),
					coverageCase,
				);
			});
		}
	});
	test("enforces configured bundle size budgets", async () => {
		const cases: ReadonlyArray<ScriptCase & { body: string | Uint8Array }> = [
			{
				name: "accepts within budget",
				body: "x".repeat(128),
				code: 0,
				stdout: [
					/bundle size ok/,
					/raw 128 bytes, gzip \d+ bytes/,
					/headroom \d+ bytes/,
				],
			},
			{
				name: "rejects over budget",
				body: deterministicBytes(512),
				code: 1,
				stderr: [/Bundle size gate failed/],
			},
		];
		for (const bundleCase of cases) {
			await withTempFile("worker.js", bundleCase.body, async (bundlePath) => {
				await assertScriptCase(
					await runNodeScript("scripts/check-bundle-size.mjs", bundlePath, {
						BUNDLE_GZIP_SIZE_LIMIT_BYTES: "256",
					}),
					bundleCase,
				);
			});
		}
	});
	test("classifies documentation-only and runtime-impacting CI changes", async () => {
		for (const [files, expected] of [
			[["README.md", "docs/images/example.png"], "docs"],
			[["src/index.ts"], "runtime"],
			[[".github/workflows/quality-gates.yml"], "runtime"],
			[[".trellis/spec/web2gem/backend/index.md"], "runtime"],
			[["migrations/0001_gemini_accounts.sql"], "runtime"],
			[["src/admin-ui/app.tsx"], "runtime"],
			[[], "runtime"],
		] as const) {
			const result = await runNodeScript(
				"scripts/classify-ci-changes.mjs",
				null,
				{
					CI_CHANGED_FILES_JSON: JSON.stringify(files),
				},
			);
			assert.equal(result.code, 0);
			assert.equal(result.stdout.trim(), expected);
		}
	});
	test("enforces text and machine-readable benchmark median budgets", async () => {
		const textCases: ReadonlyArray<
			ScriptCase & { body: string; maxMedianMs: string }
		> = [
			{
				name: "accepts within budget",
				body: "stream_sieve_held_tool          n=20  median=12.500ms  p95=13.000ms\n",
				maxMedianMs: "20",
				code: 0,
				stdout: [/benchmark gate ok/],
			},
			{
				name: "rejects over budget",
				body: "stream_sieve_held_tool          n=20  median=25.000ms  p95=26.000ms\n",
				maxMedianMs: "20",
				code: 1,
				stderr: [/Benchmark gate failed/],
			},
			{
				name: "parses microsecond medians",
				body: "stream_sieve_held_tool          n=20  median=850.0us  p95=900.0us\n",
				maxMedianMs: "1",
				code: 0,
				stdout: [/850\.0us <= 1\.000ms/],
			},
		];
		for (const benchCase of textCases) {
			await withTempFile("bench.txt", benchCase.body, async (benchPath) => {
				await assertScriptCase(
					await runNodeScript("scripts/check-benchmark.mjs", benchPath, {
						BENCH_MAX_MEDIAN_MS: benchCase.maxMedianMs,
					}),
					benchCase,
				);
			});
		}
		const budgets = JSON.stringify({
			stream_sieve_held_tool: 2,
			stream_text_cumulative_deltas: 4,
		});
		const jsonCases: ReadonlyArray<
			ScriptCase & {
				results: ReadonlyArray<{ name: string; medianMs: number }>;
			}
		> = [
			{
				name: "accepts complete gated cases",
				results: [
					{ name: "stream_sieve_held_tool", medianMs: 1.5 },
					{ name: "stream_text_cumulative_deltas", medianMs: 3.25 },
				],
				code: 0,
				stdout: [/stream_sieve_held_tool/, /stream_text_cumulative_deltas/],
			},
			{
				name: "rejects missing gated case",
				results: [{ name: "stream_sieve_held_tool", medianMs: 1.5 }],
				code: 1,
				stderr: [/missing benchmark median for stream_text_cumulative_deltas/],
			},
		];
		for (const benchCase of jsonCases) {
			await withTempFile(
				"bench.json",
				JSON.stringify({ results: benchCase.results }),
				async (benchPath) => {
					await assertScriptCase(
						await runNodeScript("scripts/check-benchmark.mjs", benchPath, {
							BENCH_GATE_BUDGETS: budgets,
						}),
						benchCase,
					);
				},
			);
		}
	});
	test("keeps Docker packaging contracts for smoke, compose, and image runtime files", async () => {
		const smokeModulePath: string = "../../scripts/docker-smoke.mjs";
		const smoke = (await import(smokeModulePath)) as {
			smokeResourceNames(
				pid: number,
				nonce: string,
			): { project: string; webImage: string; helperImage: string };
			assertLoopbackPort(raw: string, expectedContainerPort: number): number;
			assertSmokeRedacted(logs: string, secrets: readonly string[]): void;
			smokeComposeOverride(paths: {
				mockScript: string;
				certDir: string;
				stateDir: string;
			}): string;
			smokeMockServerSource(): string;
			candidateCookiePath(accountId: string): string;
			helperRecreateArgs(composeArgs: readonly string[]): string[];
		};
		assert.deepEqual(smoke.smokeResourceNames(42, "AB-cd!12"), {
			project: "web2gem-smoke-42-abcd12",
			webImage: "web2gem:smoke-42-abcd12",
			helperImage: "web2gem-browser-helper:smoke-42-abcd12",
		});
		assert.equal(smoke.assertLoopbackPort("127.0.0.1:6080", 6080), 6080);
		assert.throws(
			() => smoke.assertLoopbackPort("0.0.0.0:6080", 6080),
			/was not mapped to loopback/,
		);
		assert.throws(
			() => smoke.assertSmokeRedacted("log leaked-value", ["leaked-value"]),
			/exposed a secret/,
		);
		const override = smoke.smokeComposeOverride({
			mockScript: "C:/tmp/mock.mjs",
			certDir: "C:/tmp/certs",
			stateDir: "C:/tmp/state",
		});
		for (const required of [
			"smoke-upstream:",
			"open.feishu.cn",
			"NODE_EXTRA_CA_CERTS",
			"/smoke/certs",
			"/smoke/state",
			"web2gem-egress",
			"browser-egress",
			"condition: service_healthy",
		])
			assert.match(override, new RegExp(required.replaceAll(".", "\\.")));
		assert.doesNotMatch(override, /ports:/);
		const mockSource = smoke.smokeMockServerSource();
		assert.match(mockSource, /otAQ7b/);
		assert.match(mockSource, /createHmac/);
		assert.match(mockSource, /timingSafeEqual/);
		assert.doesNotMatch(mockSource, /console\.(?:log|error)/);
		assert.equal(
			smoke.candidateCookiePath("account a"),
			"/internal/browser/accounts/account%20a/candidate-cookie",
		);
		assert.deepEqual(smoke.helperRecreateArgs(["compose", "-f", "base"]), [
			"compose",
			"-f",
			"base",
			"up",
			"-d",
			"--no-deps",
			"--force-recreate",
			"browser-helper",
		]);
		const smokeSource = await readFile("scripts/docker-smoke.mjs", "utf8");
		assert.doesNotMatch(
			smokeSource,
			/["']down["'][^\n]*(?:["']-v["']|--volumes)/,
		);
		assert.match(smokeSource, /\$\{names\.project\}_web2gem-data/);
		assert.match(smokeSource, /\$\{names\.project\}_browser-profiles/);

		await withTempDir(async (dir) => {
			const result = await runNodeScript("scripts/docker-smoke.mjs", null, {
				PATH: dir,
			});
			assert.equal(result.code, 0);
			assert.match(
				result.stdout,
				/Docker smoke skipped: docker executable not found/,
			);
		});

		const compose = await readFile("compose.yaml", "utf8");
		const dockerEnv = await readFile(".env.docker.example", "utf8");
		assert.match(compose, /\$\{PORT:-52389\}:\$\{PORT:-52389\}/);
		assert.doesNotMatch(compose, /\$\{PORT:-52389\}:52389/);
		for (const source of [compose, dockerEnv])
			assert.match(source, /web2gem-account-pool:local/);
		assert.match(compose, /build:\s*\./);
		assert.match(compose, /pull_policy:\s*never/);
		assert.match(compose, /web2gem-data:\/data/);
		assert.match(
			compose,
			/SQLITE_PATH:\s*"\$\{SQLITE_PATH:-\/data\/web2gem\.sqlite\}"/,
		);
		assert.match(compose, /healthcheck:/);
		assert.match(
			compose,
			/REQUEST_BODY_MAX_BYTES:\s*"\$\{REQUEST_BODY_MAX_BYTES:-67108864\}"/,
		);

		const server = await readFile("server/docker-server.mjs", "utf8");
		const dockerfile = await readFile("Dockerfile", "utf8");
		const runtimeImports = Array.from(
			server.matchAll(/from\s+["']\.\/(.+?\.mjs)["']/g),
			(match) => requiredString(match[1], "runtime import"),
		);
		assert.deepEqual(runtimeImports.sort(), [
			"browser-helper-client.mjs",
			"credential-crypto.mjs",
			"io.mjs",
			"secrets.mjs",
			"sqlite-binding.mjs",
		]);
		for (const filename of runtimeImports) {
			assert.match(
				dockerfile,
				new RegExp(
					`COPY --from=build /app/server/${filename.replace(".", "\\.")}`,
				),
			);
		}
		assert.match(
			dockerfile,
			/COPY --from=build \/app\/migrations \.\/migrations/,
		);
	});
	test("keeps the browser helper image and Compose boundary hardened", async () => {
		const [compose, helperDockerfile, dockerEnv, helperMain, chromiumSource] =
			await Promise.all([
				readFile("compose.yaml", "utf8"),
				readFile("Dockerfile.browser-helper", "utf8"),
				readFile(".env.docker.example", "utf8"),
				readFile("browser-helper/main.mjs", "utf8"),
				readFile("browser-helper/chromium.mjs", "utf8"),
			]);
		const web2gemService = composeServiceBlock(compose, "web2gem");
		const helperService = composeServiceBlock(compose, "browser-helper");
		const servicesSection = compose.slice(
			compose.indexOf("services:"),
			compose.indexOf("\nvolumes:"),
		);

		assert.deepEqual(
			Array.from(
				servicesSection.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm),
				(match) => match[1],
			),
			["web2gem", "browser-helper"],
		);
		assert.match(compose, /127\.0\.0\.1:\$\{NOVNC_PORT:-6080\}:6080/);
		assert.equal((compose.match(/^\s{4}ports:\s*$/gm) || []).length, 2);
		assert.match(
			compose,
			/^\s{2}browser-internal:\s*\n\s{4}internal:\s*true\s*$/m,
		);
		assert.match(compose, /^\s{2}browser-profiles:\s*$/m);
		assert.match(compose, /^\s{2}web2gem-data:\s*$/m);
		assert.match(compose, /browser-profiles:\/profiles/);
		assert.doesNotMatch(helperService, /web2gem-data:\/data/);
		assert.doesNotMatch(web2gemService, /browser-profiles:\/profiles/);
		assert.equal(
			(compose.match(/source:\s*web2gem_master_key/g) || []).length,
			2,
		);
		assert.equal(
			(compose.match(/target:\s*web2gem_master_key/g) || []).length,
			2,
		);
		assert.equal((compose.match(/mode:\s*0400/g) || []).length, 2);
		assert.match(
			compose,
			/file:\s*"\$\{WEB2GEM_MASTER_KEY_FILE:-\.\/secrets\/web2gem_master_key\}"/,
		);
		assert.match(helperService, /healthcheck:/);
		assert.match(helperService, /fetch\('http:\/\/127\.0\.0\.1:'/);
		assert.match(helperService, /'\/health'/);
		assert.match(
			web2gemService,
			/BROWSER_HELPER_INTERNAL_URL:\s*"http:\/\/browser-helper:6081"/,
		);
		assert.match(helperService, /BROWSER_HELPER_CONTROL_PORT:\s*"6081"/);
		assert.match(helperService, /expose:\s*\n\s*- "6081"/);
		for (const service of [web2gemService, helperService]) {
			assert.match(
				service,
				/NO_PROXY:[^\n]*web2gem[^\n]*browser-helper[^\n]*127\.0\.0\.1[^\n]*localhost/,
			);
		}

		assert.match(
			helperDockerfile,
			/^FROM m\.daocloud\.io\/docker\.io\/library\/node:26-bookworm-slim/m,
		);
		const runtimePackages = [
			"ca-certificates",
			"chromium",
			"fonts-noto-cjk",
			"novnc",
			"tini",
			"websockify",
			"xvfb",
			"x11vnc",
		].sort();
		for (const runtimePackage of runtimePackages)
			assert.match(helperDockerfile, new RegExp(`\\b${runtimePackage}\\b`));
		const installBlock =
			/apt-get install -y --no-install-recommends([\s\S]*?)&& rm/.exec(
				helperDockerfile,
			)?.[1];
		if (!installBlock) throw new Error("missing helper apt install block");
		assert.deepEqual(
			installBlock.replaceAll("\\", " ").trim().split(/\s+/).sort(),
			runtimePackages,
		);
		assert.match(helperDockerfile, /rm -rf \/var\/lib\/apt\/lists\/\*/);
		assert.doesNotMatch(helperDockerfile, /^USER\s+/m);
		assert.match(helperDockerfile, /\/profiles/);
		assert.match(helperDockerfile, /\/run\/browser-helper/);
		assert.match(helperDockerfile, /pnpm install --prod --frozen-lockfile/);
		assert.match(helperDockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--"\]/);
		assert.match(
			helperDockerfile,
			/CMD \["node", "--use-env-proxy", "browser-helper\/entrypoint\.mjs"\]/,
		);
		assert.match(
			helperDockerfile,
			/COPY --chown=browser:browser browser-helper/,
		);
		assert.match(helperMain, /from "\.\.\/server\/secrets\.mjs"/);
		assert.match(
			helperDockerfile,
			/server\/secrets\.mjs \.\/server\/secrets\.mjs/,
		);
		assert.match(chromiumSource, /executablePath = "\/usr\/bin\/chromium"/);
		assert.match(
			web2gemService,
			/command: \["node", "--use-env-proxy", "server\/docker-server\.mjs"\]/,
		);

		for (const key of [
			"BROWSER_HELPER_INTERNAL_TOKEN",
			"NOVNC_PASSWORD",
			"NOVNC_PUBLIC_URL",
			"FEISHU_WEBHOOK_URL",
			"FEISHU_SIGNING_SECRET",
			"BROWSER_CHECK_INTERVAL_SEC",
			"BROWSER_CHECK_JITTER_SEC",
			"BROWSER_VISIBLE_IDLE_TIMEOUT_SEC",
			"BROWSER_VISIBLE_SUBMISSION_TIMEOUT_SEC",
			"BROWSER_AUTLOGIN_MAX_ATTEMPTS_PER_DAY",
			"BROWSER_MAX_CLOCK_SKEW_SEC",
		])
			assert.match(dockerEnv, new RegExp(`^${key}=$`, "m"));
		for (const internalOnly of [
			"BROWSER_HELPER_INTERNAL_URL",
			"BROWSER_HELPER_CONTROL_PORT",
		])
			assert.doesNotMatch(dockerEnv, new RegExp(`^${internalOnly}=`, "m"));

		const deploymentFiles = `${helperDockerfile}\n${compose}`;
		assert.doesNotMatch(
			deploymentFiles,
			/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{20,}/,
		);
		assert.doesNotMatch(
			deploymentFiles,
			/(?:BROWSER_HELPER_INTERNAL_TOKEN|NOVNC_PASSWORD|FEISHU_WEBHOOK_URL|FEISHU_SIGNING_SECRET):\s*"(?!\$\{)[^"\n]+"/,
		);
		assert.doesNotMatch(deploymentFiles, /ALL_PROXY/);
		assert.doesNotMatch(helperMain, /ALL_PROXY|all_proxy/);
		assert.doesNotMatch(dockerEnv, /^ALL_PROXY=/m);
		assert.match(dockerEnv, /VNC[^\n]*first 8 characters/i);
		assert.match(dockerEnv, /random[^\n]*loopback/i);
	});
	test("derives public noVNC URLs from NOVNC_PORT in rendered Compose", async () => {
		await withTempFile(
			"browser-helper.env",
			"NOVNC_PORT=6099\nNO_PROXY=corp.example\n",
			async (envPath) => {
				const render = async () => {
					const result = await runExecutable(
						"docker",
						[
							"compose",
							"--env-file",
							envPath,
							"--file",
							join(process.cwd(), "compose.yaml"),
							"config",
							"--format",
							"json",
						],
						["NOVNC_PORT", "NOVNC_PUBLIC_URL", "NO_PROXY"],
					);
					if (result.missing) return null;
					assert.equal(result.code, 0, result.stderr);
					return requiredRecord(JSON.parse(result.stdout), "Compose config");
				};
				const assertRendered = (config: UnknownRecord, publicUrl: string) => {
					const services = requiredRecord(config.services, "Compose services");
					const helper = requiredRecord(
						services["browser-helper"],
						"browser-helper",
					);
					const web2gem = requiredRecord(services.web2gem, "web2gem");
					const ports = helper.ports;
					assert.equal(Array.isArray(ports), true);
					const noVncPort = requiredRecord(
						(ports as unknown[])[0],
						"noVNC port",
					);
					assert.equal(String(noVncPort.published), "6099");
					for (const service of [web2gem, helper]) {
						const environment = requiredRecord(
							service.environment,
							"environment",
						);
						assert.equal(environment.NOVNC_PUBLIC_URL, publicUrl);
						assert.equal(
							environment.NO_PROXY,
							"corp.example,web2gem,browser-helper,127.0.0.1,localhost,::1",
						);
					}
				};

				const derived = await render();
				if (!derived) return;
				assertRendered(derived, "http://127.0.0.1:6099/vnc.html");
				await writeFile(
					envPath,
					"NOVNC_PORT=6099\nNO_PROXY=corp.example\nNOVNC_PUBLIC_URL=http://localhost:6099/custom.html\n",
					"utf8",
				);
				const overridden = await render();
				if (!overridden)
					throw new Error("Docker disappeared during Compose test");
				assertRendered(overridden, "http://localhost:6099/custom.html");
			},
		);
	});
	test("keeps env secret templates trackable in docker and git ignore files", async () => {
		const dockerPatterns = parseIgnorePatterns(
			await readFile(".dockerignore", "utf8"),
		);
		const gitPatterns = parseIgnorePatterns(
			await readFile(".gitignore", "utf8"),
		);
		const dockerExcluded = new Set(
			dockerPatterns.filter((line) => !line.startsWith("!")),
		);
		for (const pattern of [".env", ".env.*"]) {
			assert.equal(
				gitPatterns.includes(pattern),
				true,
				`gitignore missing ${pattern}`,
			);
			assert.equal(
				dockerExcluded.has(pattern),
				true,
				`dockerignore missing ${pattern}`,
			);
		}
		for (const pattern of [
			"tests",
			"docs",
			"release-assets",
			"reports",
			"secrets",
			"profiles",
			"screenshots",
			"runtime",
			"*.sqlite",
			"*.sqlite-*",
			".worktrees",
		]) {
			assert.equal(
				dockerExcluded.has(pattern),
				true,
				`dockerignore missing ${pattern}`,
			);
		}
		for (const [dockerPattern, gitPattern] of [
			["secrets", "secrets/"],
			["profiles", "profiles/"],
			["screenshots", "screenshots/"],
			["runtime", "runtime/"],
			["*.sqlite", "*.sqlite"],
			["*.sqlite-*", "*.sqlite-*"],
		] as const) {
			assert.equal(dockerExcluded.has(dockerPattern), true, dockerPattern);
			assert.equal(gitPatterns.includes(gitPattern), true, gitPattern);
		}
		for (const example of ["!.env.docker.example"]) {
			assert.equal(
				gitPatterns.includes(example),
				true,
				`gitignore missing ${example}`,
			);
			assert.equal(
				dockerPatterns.includes(example),
				true,
				`dockerignore missing ${example}`,
			);
		}
		assert.equal(
			dockerPatterns.indexOf("!.env.docker.example") >
				dockerPatterns.indexOf(".env.*"),
			true,
		);
		for (const dockerInput of [
			"package.json",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			"tsconfig.json",
			"scripts",
			"src",
		]) {
			assert.equal(dockerExcluded.has(dockerInput), false, dockerInput);
		}
	});
	test("keeps runtime config env keys aligned with Docker docs and Compose", async () => {
		const dockerEnvExample = parseEnvExampleKeys(
			await readFile(".env.docker.example", "utf8"),
		);
		const compose = await readFile("compose.yaml", "utf8");
		const composeEnv = parseComposeEnvironmentKeys(compose);
		const composeVariables = parseComposeVariableReferences(compose);
		const configKeys = CONFIG_ENV_KEYS;

		assert.deepEqual(missingKeys(configKeys, dockerEnvExample), []);
		assert.deepEqual(missingKeys(configKeys, composeEnv), []);
		assert.deepEqual(missingKeys(DOCKER_ONLY_ENV_KEYS, dockerEnvExample), []);
		assert.deepEqual(missingKeys(DOCKER_ONLY_ENV_KEYS, composeVariables), []);
	});
	test("keeps README quality-command docs aligned with config", async () => {
		const [[english, chinese], vitestConfig] = await Promise.all([
			readBothReadmes(),
			readFile("vitest.config.mjs", "utf8"),
		]);

		for (const readme of [english, chinese]) {
			for (const command of [
				"pnpm check:static",
				"pnpm typecheck",
				"pnpm typecheck:tests",
				"pnpm check:arch",
				"pnpm unit",
				"pnpm coverage:ci",
				"pnpm smoke",
				"pnpm check:bench",
				"pnpm check:size",
				"pnpm docker:smoke",
			]) {
				assert.match(readme, new RegExp(command.replace(":", "\\:")));
			}
			assert.match(readme, /lcov/);
			assert.match(readme, /JSON summary/);
			assert.doesNotMatch(readme, /Vitest V8 text/);
		}
		assert.match(vitestConfig, /reporter:\s*\["lcov", "json-summary"\]/);
		for (const pattern of ["unit", "integration"])
			assert.match(
				vitestConfig,
				new RegExp(`tests/${pattern}/\\*\\*/\\*\\.test\\.\\{ts,tsx\\}`),
			);
		assert.match(vitestConfig, /fileParallelism:\s*true/);
		assert.match(vitestConfig, /pool:\s*"threads"/);
		assert.doesNotMatch(vitestConfig, /isolate:\s*false/);
	});
	test("keeps command runners centralized across quality scripts", async () => {
		const processHelper = await readFile("scripts/process.mjs", "utf8");
		assert.match(processHelper, /export function runPnpm/);
		assert.match(processHelper, /export function runCommand/);
		assert.match(processHelper, /export function outputCommand/);
		assert.match(processHelper, /export async function commandAvailable/);

		for (const path of [
			"scripts/coverage.mjs",
			"scripts/docker-smoke.mjs",
			"scripts/check-release.mjs",
			"scripts/check-benchmark.mjs",
		]) {
			const source = await readFile(path, "utf8");
			assert.match(source, /from "\.\/process\.mjs"/, path);
			assert.doesNotMatch(source, /from "node:child_process"/, path);
		}
	});
	test("keeps esbuild targets aligned with the TypeScript baseline", async () => {
		const tsconfig = requiredRecord(
			JSON.parse(await readFile("tsconfig.json", "utf8")),
			"tsconfig.json",
		);
		const compilerOptions = requiredRecord(
			tsconfig.compilerOptions,
			"TypeScript compiler options",
		);
		const expectedTarget = String(compilerOptions.target).toLowerCase();
		const buildScript = await readFile("scripts/build.mjs", "utf8");
		const adminBuildScript = await readFile(
			"scripts/build-admin-ui.mjs",
			"utf8",
		);

		assert.match(
			buildScript,
			new RegExp(`target:\\s*"${expectedTarget}"`),
			"scripts/build.mjs",
		);
		assert.match(
			adminBuildScript,
			new RegExp(`target:\\s*"${expectedTarget}"`),
			"scripts/build-admin-ui.mjs",
		);
	});
	test("keeps Docker-only quality gates complete", async () => {
		const workflow = await readFile(
			".github/workflows/quality-gates.yml",
			"utf8",
		);
		assert.match(workflow, /pnpm check:static/);
		assert.match(workflow, /pnpm typecheck/);
		assert.match(workflow, /pnpm unit/);
		assert.match(workflow, /Docker smoke/);
	});
});
