import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
	guardedBatch(
		guard: SqliteStatement,
		statements: SqliteStatement[],
	): Promise<{ committed: boolean; results: SqliteResult[] }>;
	close(): void;
};

type SqliteConfig = {
	path: string;
	busyTimeoutMs: number;
};

type SqliteOptions = {
	Database?: typeof DatabaseSync;
	migrationsDirectory?: string;
	migrationPath?: string;
	migrationSql?: string | null;
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
	(config: SqliteConfig, options?: SqliteOptions) => SqliteBinding
>(sqliteModule, "createSqliteBinding");
const createSqliteBindingFromEnv = moduleFunction<
	(env?: Record<string, unknown>, options?: SqliteOptions) => SqliteBinding
>(sqliteModule, "createSqliteBindingFromEnv");
const resolveSqliteConfig = moduleFunction<
	(env?: Record<string, unknown>) => SqliteConfig
>(sqliteModule, "resolveSqliteConfig");
const migrationFiles = moduleFunction<(directory: string) => string[]>(
	sqliteModule,
	"migrationFiles",
);

const BROWSER_STATES = [
	"idle",
	"checking",
	"ready",
	"login_required",
	"manual_action_required",
	"error",
] as const;

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

	test("guarded batches skip dependent statements and roll back on a missing guard row", async () => {
		const binding = createSqliteBinding(
			{ path: ":memory:", busyTimeoutMs: 1000 },
			{ migrationSql: SIMPLE_MIGRATION },
		);
		try {
			await binding
				.prepare("INSERT INTO items(value) VALUES (?)")
				.bind("original")
				.run();
			assert.deepEqual(
				await binding.guardedBatch(
					binding
						.prepare(
							"UPDATE OR IGNORE items SET value = ? WHERE id = ? RETURNING id",
						)
						.bind("ignored", 99),
					[
						binding
							.prepare("INSERT INTO items(value) VALUES (?)")
							.bind("must-not-run"),
					],
				),
				{ committed: false, results: [] },
			);
			assert.deepEqual(
				(await binding.prepare("SELECT value FROM items ORDER BY id").all())
					.results,
				[{ value: "original" }],
			);
			assert.equal(
				(
					await binding.guardedBatch(
						binding
							.prepare(
								"UPDATE OR IGNORE items SET value = ? WHERE id = ? RETURNING id",
							)
							.bind("updated", 1),
						[
							binding
								.prepare("INSERT INTO items(value) VALUES (?)")
								.bind("dependent"),
						],
					)
				).committed,
				true,
			);
			assert.deepEqual(
				(await binding.prepare("SELECT value FROM items ORDER BY id").all())
					.results,
				[{ value: "updated" }, { value: "dependent" }],
			);
		} finally {
			binding.close();
		}
	});

	test("guarded batches roll back a successful guard when a dependent statement fails", async () => {
		const binding = createSqliteBinding(
			{ path: ":memory:", busyTimeoutMs: 1000 },
			{ migrationSql: SIMPLE_MIGRATION },
		);
		try {
			await binding
				.prepare("INSERT INTO items(value) VALUES (?)")
				.bind("original")
				.run();
			await assert.rejects(
				() =>
					binding.guardedBatch(
						binding
							.prepare("UPDATE items SET value = ? WHERE id = ? RETURNING id")
							.bind("guarded-secret", 1),
						[
							binding
								.prepare("INSERT INTO items(value) VALUES (?)")
								.bind("guarded-secret"),
						],
					),
				/SQLite guarded batch failed/,
			);
			assert.equal(
				await binding
					.prepare("SELECT value FROM items WHERE id = 1")
					.first("value"),
				"original",
			);
		} catch (error) {
			assert.doesNotMatch(String(error), /guarded-secret/);
			throw error;
		} finally {
			binding.close();
		}
	});

	test("guarded batches reject a guard that returns more than one row", async () => {
		const binding = createSqliteBinding(
			{ path: ":memory:", busyTimeoutMs: 1000 },
			{ migrationSql: SIMPLE_MIGRATION },
		);
		try {
			await binding.batch([
				binding.prepare("INSERT INTO items(value) VALUES ('one')"),
				binding.prepare("INSERT INTO items(value) VALUES ('two')"),
			]);
			assert.deepEqual(
				await binding.guardedBatch(binding.prepare("SELECT id FROM items"), [
					binding.prepare("INSERT INTO items(value) VALUES ('must-not-run')"),
				]),
				{ committed: false, results: [] },
			);
			assert.equal(
				await binding.prepare("SELECT COUNT(*) FROM items").first("COUNT(*)"),
				2,
			);
		} finally {
			binding.close();
		}
	});

	test("discovers ordered migration files and rejects duplicate identifiers", () => {
		const directory = mkdtempSync(join(tmpdir(), "web2gem-migrations-"));
		try {
			for (const file of [
				"0002_second.sql",
				"notes.sql",
				"0001_first.sql",
				"0003-UPPER.sql",
			])
				writeFileSync(join(directory, file), "SELECT 1;");
			assert.deepEqual(
				migrationFiles(directory).map((file) => file.split(/[\\/]/).at(-1)),
				["0001_first.sql", "0002_second.sql"],
			);

			writeFileSync(join(directory, "0002_duplicate.sql"), "SELECT 1;");
			assert.throws(
				() => migrationFiles(directory),
				/duplicate migration identifier/,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("rolls back and closes a file database when an ordered migration fails", async () => {
		const directory = mkdtempSync(join(tmpdir(), "web2gem-migration-failure-"));
		const migrationsDirectory = join(directory, "migrations");
		const path = join(directory, "pool.sqlite");
		let rollbackObserved = false;
		let failedDatabaseClosed = false;
		class TrackedDatabase extends DatabaseSync {
			override exec(sql: string) {
				if (sql === "ROLLBACK") rollbackObserved = true;
				return super.exec(sql);
			}

			override close() {
				assert.equal(rollbackObserved, true);
				failedDatabaseClosed = true;
				super.close();
			}
		}
		try {
			mkdirSync(migrationsDirectory);
			writeFileSync(
				join(migrationsDirectory, "0001_probe.sql"),
				"CREATE TABLE migration_probe (value TEXT UNIQUE); INSERT INTO migration_probe VALUES ('first');",
				{ flush: true },
			);
			writeFileSync(
				join(migrationsDirectory, "0002_broken.sql"),
				"CREATE TABLE migration_secret_token (",
				{ flush: true },
			);
			try {
				createSqliteBinding(
					{ path, busyTimeoutMs: 1000 },
					{ Database: TrackedDatabase, migrationsDirectory },
				);
				throw new Error("expected malformed migration to fail");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				assert.match(message, /failed to initialize SQLite storage/);
				assert.doesNotMatch(message, /migration_secret_token/);
			}
			assert.equal(rollbackObserved, true);
			assert.equal(failedDatabaseClosed, true);

			writeFileSync(
				join(migrationsDirectory, "0002_broken.sql"),
				"CREATE TABLE migration_recovery (value TEXT);",
				{ flush: true },
			);
			const recovered = createSqliteBinding(
				{ path, busyTimeoutMs: 1000 },
				{ migrationsDirectory },
			);
			try {
				assert.deepEqual(
					(await recovered.prepare("SELECT value FROM migration_probe").all())
						.results,
					[{ value: "first" }],
				);
			} finally {
				recovered.close();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("falls back to migrationPath when migrationSql is null", async () => {
		const directory = mkdtempSync(join(tmpdir(), "web2gem-null-migration-"));
		const migrationPath = join(directory, "fallback.sql");
		try {
			writeFileSync(migrationPath, SIMPLE_MIGRATION);
			const binding = createSqliteBinding(
				{ path: ":memory:", busyTimeoutMs: 1000 },
				{ migrationSql: null, migrationPath },
			);
			try {
				assert.equal(
					await binding
						.prepare(
							"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'",
						)
						.first("name"),
					"items",
				);
			} finally {
				binding.close();
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("applies browser metadata migration idempotently with cascading accounts", async () => {
		const directory = mkdtempSync(join(tmpdir(), "web2gem-sqlite-"));
		const path = join(directory, "pool.sqlite");
		try {
			const first = createSqliteBindingFromEnv({ SQLITE_PATH: path });
			assert.equal(
				await first
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gemini_browser_accounts'",
					)
					.first("name"),
				"gemini_browser_accounts",
			);
			for (const [index, state] of BROWSER_STATES.entries()) {
				const accountId = `account-${index + 1}`;
				await first
					.prepare(
						`INSERT INTO gemini_accounts (
							id, cookie_header, cookie_hash, identity_hash, created_at_ms, updated_at_ms
						) VALUES (?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						accountId,
						`cookie-${index}`,
						`cookie-hash-${index}`,
						`identity-hash-${index}`,
						1,
						1,
					)
					.run();
				await first
					.prepare(
						"INSERT INTO gemini_browser_accounts (account_id, browser_state, updated_at_ms) VALUES (?, ?, ?)",
					)
					.bind(accountId, state, 1)
					.run();
			}
			await assert.rejects(
				() =>
					first
						.prepare(
							"UPDATE gemini_browser_accounts SET browser_state = 'unknown' WHERE account_id = 'account-1'",
						)
						.run(),
				/SQLite query failed/,
			);
			await first
				.prepare("DELETE FROM gemini_accounts WHERE id = ?")
				.bind("account-1")
				.run();
			assert.equal(
				await first
					.prepare(
						"SELECT COUNT(*) AS count FROM gemini_browser_accounts WHERE account_id = ?",
					)
					.bind("account-1")
					.first("count"),
				0,
			);
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
