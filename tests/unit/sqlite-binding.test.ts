import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { isRecord } from "../../src/shared/types";
import { assert } from "./assertions.js";

type SqliteResult = {
	results: Record<string, unknown>[];
	success: boolean;
	meta: Record<string, unknown>;
};

type SqliteStatement = {
	bind(...values: unknown[]): SqliteStatement;
	first(columnName?: string): Promise<unknown>;
	all(): Promise<SqliteResult>;
	run(): Promise<SqliteResult>;
};

type SqliteBinding = {
	prepare(sql: string): SqliteStatement;
	batch(statements: SqliteStatement[]): Promise<SqliteResult[]>;
	close(): void;
};

type SqliteConfig = {
	path: string;
	busyTimeoutMs: number;
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

const sqliteModule = await importUnknown(
	new URL("../../server/sqlite-binding.mjs", import.meta.url).href,
);
const createSqliteBinding = moduleFunction<
	(
		config: SqliteConfig,
		options?: { migrationSql?: string; migrationPath?: string },
	) => SqliteBinding
>(sqliteModule, "createSqliteBinding");
const createSqliteBindingFromEnv = moduleFunction<
	(
		env?: Record<string, unknown>,
		options?: { migrationSql?: string; migrationPath?: string },
	) => SqliteBinding
>(sqliteModule, "createSqliteBindingFromEnv");
const resolveSqliteConfig = moduleFunction<
	(env?: Record<string, unknown>) => SqliteConfig
>(sqliteModule, "resolveSqliteConfig");

const SIMPLE_MIGRATION = `
	CREATE TABLE IF NOT EXISTS items (
		id INTEGER PRIMARY KEY,
		value TEXT NOT NULL UNIQUE
	);
`;

describe("Docker SQLite binding", () => {
	test("resolves paths and validates the busy timeout", () => {
		assert.equal(
			resolveSqliteConfig({ SQLITE_PATH: ":memory:" }).path,
			":memory:",
		);
		assert.equal(
			resolveSqliteConfig({ SQLITE_PATH: ":memory:" }).busyTimeoutMs,
			5000,
		);
		assert.equal(
			resolveSqliteConfig({
				SQLITE_PATH: ":memory:",
				SQLITE_BUSY_TIMEOUT_MS: "1234",
			}).busyTimeoutMs,
			1234,
		);
		assert.throws(
			() =>
				resolveSqliteConfig({
					SQLITE_PATH: ":memory:",
					SQLITE_BUSY_TIMEOUT_MS: "0",
				}),
			/positive integer/,
		);
	});

	test("maps prepare bind first all run and returning results", async () => {
		const binding = createSqliteBinding(
			{ path: ":memory:", busyTimeoutMs: 1000 },
			{ migrationSql: SIMPLE_MIGRATION },
		);
		try {
			const prepared = binding.prepare(
				"INSERT INTO items(value) VALUES (?) RETURNING id, value",
			);
			const inserted = await prepared.bind("alpha").run();
			assert.deepEqual(inserted.results, [{ id: 1, value: "alpha" }]);
			assert.equal(inserted.meta.changes, 1);
			assert.deepEqual(
				(await binding.prepare("SELECT * FROM items").all()).results,
				[{ id: 1, value: "alpha" }],
			);
			assert.equal(
				await binding
					.prepare("SELECT value FROM items WHERE id = ?")
					.bind(1)
					.first("value"),
				"alpha",
			);
			assert.equal(await prepared.bind("beta").first("value"), "beta");
			assert.deepEqual(
				(await binding.prepare("SELECT value FROM items ORDER BY id").all())
					.results,
				[{ value: "alpha" }, { value: "beta" }],
			);
		} finally {
			binding.close();
			binding.close();
		}
		assert.throws(() => binding.prepare("SELECT 1"), /storage is closed/);
	});

	test("commits valid batches and rolls back failed batches", async () => {
		const binding = createSqliteBinding(
			{ path: ":memory:", busyTimeoutMs: 1000 },
			{ migrationSql: SIMPLE_MIGRATION },
		);
		const other = createSqliteBinding(
			{ path: ":memory:", busyTimeoutMs: 1000 },
			{ migrationSql: SIMPLE_MIGRATION },
		);
		try {
			assert.deepEqual(
				await binding.batch([
					binding.prepare("INSERT INTO items(value) VALUES (?)").bind("one"),
					binding.prepare("SELECT value FROM items WHERE id = ?").bind(1),
				]),
				[
					{
						results: [],
						success: true,
						meta: { changes: 1, last_row_id: 1 },
					},
					{
						results: [{ value: "one" }],
						success: true,
						meta: { changes: 0 },
					},
				],
			);
			await assert.rejects(
				() =>
					binding.batch([
						binding.prepare("INSERT INTO items(value) VALUES (?)").bind("two"),
						binding.prepare("INSERT INTO items(value) VALUES (?)").bind("one"),
					]),
				/SQLite batch failed/,
			);
			assert.equal(
				await binding
					.prepare("SELECT COUNT(*) AS count FROM items")
					.first("count"),
				1,
			);
			await assert.rejects(
				() => binding.batch([other.prepare("SELECT 1")]),
				/belongs to another binding/,
			);
			assert.deepEqual(await binding.batch([]), []);
		} finally {
			binding.close();
			other.close();
		}
	});

	test("initializes idempotently and persists data in a file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "web2gem-sqlite-"));
		const path = join(directory, "pool.sqlite");
		try {
			const first = createSqliteBindingFromEnv({ SQLITE_PATH: path });
			await first
				.prepare(
					"UPDATE gemini_pool_meta SET value = ? WHERE key = 'pool_version'",
				)
				.bind("17")
				.run();
			first.close();

			const second = createSqliteBindingFromEnv({ SQLITE_PATH: path });
			assert.equal(
				await second
					.prepare(
						"SELECT value FROM gemini_pool_meta WHERE key = 'pool_version'",
					)
					.first("value"),
				"17",
			);
			second.close();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("fails closed with secret-safe initialization and query errors", async () => {
		assert.throws(
			() =>
				createSqliteBinding(
					{ path: ":memory:", busyTimeoutMs: 1000 },
					{ migrationSql: "CREATE TABLE" },
				),
			/failed to initialize SQLite storage/,
		);
		const binding = createSqliteBinding(
			{ path: ":memory:", busyTimeoutMs: 1000 },
			{ migrationSql: SIMPLE_MIGRATION },
		);
		try {
			await binding
				.prepare("INSERT INTO items(value) VALUES (?)")
				.bind("session-token-secret")
				.run();
			try {
				await binding
					.prepare("INSERT INTO items(value) VALUES (?)")
					.bind("session-token-secret")
					.run();
				throw new Error("expected duplicate value to fail");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /SQLite query failed/);
				assert.doesNotMatch(message, /session-token-secret/);
			}
		} finally {
			binding.close();
		}
	});
});
