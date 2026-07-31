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
type AsyncPathCallback = (path: string) => Promise<void>;
type AsyncDirCallback = (path: string) => Promise<void>;

const DOCKER_ONLY_ENV_KEYS = [
	"PORT",
	"WEB2GEM_IMAGE",
	"SQLITE_PATH",
	"SQLITE_BUSY_TIMEOUT_MS",
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
		for (const pattern of ["tests", "docs", "release-assets", "reports"]) {
			assert.equal(
				dockerExcluded.has(pattern),
				true,
				`dockerignore missing ${pattern}`,
			);
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
		assert.match(
			vitestConfig,
			/include:\s*\["tests\/unit\/\*\*\/\*\.test\.\{ts,tsx\}"\]/,
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
