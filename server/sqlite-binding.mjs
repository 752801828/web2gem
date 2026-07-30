import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_SQLITE_PATH = "/data/web2gem.sqlite";
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;

const DEFAULT_MIGRATION_PATH = fileURLToPath(
	new URL("../migrations/0001_gemini_accounts.sql", import.meta.url),
);

export function resolveSqliteConfig(env = process.env) {
	const rawPath = clean(env.SQLITE_PATH) || DEFAULT_SQLITE_PATH;
	if (rawPath.includes("\0")) {
		throw new SqliteBindingError("invalid SQLite database path", {
			code: "sqlite_invalid_path",
		});
	}
	const path = rawPath === ":memory:" ? rawPath : resolve(rawPath);
	return {
		path,
		busyTimeoutMs: positiveInteger(
			env.SQLITE_BUSY_TIMEOUT_MS,
			DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
		),
	};
}

export function createSqliteBindingFromEnv(env = process.env, options = {}) {
	return createSqliteBinding(resolveSqliteConfig(env), options);
}

export function createSqliteBinding(config, options = {}) {
	const Database = options.Database || DatabaseSync;
	const path = config.path;
	if (path !== ":memory:") {
		try {
			mkdirSync(dirname(path), { recursive: true });
		} catch {
			throw new SqliteBindingError("failed to prepare SQLite directory", {
				code: "sqlite_directory_error",
			});
		}
	}

	let database;
	try {
		database = new Database(path, {
			enableForeignKeyConstraints: true,
			readBigInts: false,
			timeout: config.busyTimeoutMs,
		});
		database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
		const migrationSql =
			options.migrationSql ??
			readFileSync(options.migrationPath || DEFAULT_MIGRATION_PATH, "utf8");
		database.exec(migrationSql);
	} catch {
		try {
			database?.close();
		} catch {}
		throw new SqliteBindingError("failed to initialize SQLite storage", {
			code: "sqlite_init_error",
		});
	}

	const owner = {};
	let closed = false;
	const binding = {
		prepare(sql) {
			assertOpen();
			return new SqlitePreparedStatement({
				database,
				sql: String(sql || ""),
				params: [],
				owner,
				assertOpen,
			});
		},
		async batch(statements) {
			assertOpen();
			if (!Array.isArray(statements)) {
				throw new SqliteBindingError("SQLite batch requires statements", {
					code: "sqlite_invalid_batch",
				});
			}
			if (!statements.length) return [];
			for (const statement of statements) {
				if (!(statement instanceof SqlitePreparedStatement)) {
					throw new SqliteBindingError(
						"SQLite batch received an invalid statement",
						{ code: "sqlite_invalid_batch_statement" },
					);
				}
				statement.assertOwner(owner);
			}
			try {
				database.exec("BEGIN IMMEDIATE");
				const results = statements.map((statement) => statement.execute(owner));
				database.exec("COMMIT");
				return results;
			} catch {
				try {
					if (database.isTransaction) database.exec("ROLLBACK");
				} catch {}
				throw new SqliteBindingError("SQLite batch failed", {
					code: "sqlite_batch_error",
				});
			}
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				database.close();
			} catch {
				throw new SqliteBindingError("failed to close SQLite storage", {
					code: "sqlite_close_error",
				});
			}
		},
	};

	function assertOpen() {
		if (closed) {
			throw new SqliteBindingError("SQLite storage is closed", {
				code: "sqlite_closed",
			});
		}
	}

	return binding;
}

export class SqliteBindingError extends Error {
	constructor(message, metadata = {}) {
		super(message);
		this.name = "SqliteBindingError";
		this.code = metadata.code || "sqlite_error";
	}
}

class SqlitePreparedStatement {
	constructor({ database, sql, params, owner, assertOpen }) {
		this.database = database;
		this.sql = sql;
		this.params = params;
		this.owner = owner;
		this.assertOpen = assertOpen;
	}

	bind(...values) {
		this.assertOpen();
		return new SqlitePreparedStatement({
			database: this.database,
			sql: this.sql,
			params: values,
			owner: this.owner,
			assertOpen: this.assertOpen,
		});
	}

	assertOwner(owner) {
		if (owner !== this.owner) {
			throw new SqliteBindingError(
				"SQLite batch statement belongs to another binding",
				{ code: "sqlite_batch_binding_mismatch" },
			);
		}
	}

	execute(owner = this.owner) {
		this.assertOpen();
		this.assertOwner(owner);
		try {
			const statement = this.database.prepare(this.sql);
			const hasRows = statement.columns().length > 0;
			if (hasRows) {
				const results = statement.all(...this.params);
				const changes = isMutationSql(this.sql)
					? Number(
							this.database.prepare("SELECT changes() AS value").get()?.value ||
								0,
						)
					: 0;
				return normalizedResult(results, { changes });
			}
			const result = statement.run(...this.params);
			return normalizedResult([], {
				changes: Number(result.changes || 0),
				last_row_id: safeInteger(result.lastInsertRowid),
			});
		} catch {
			throw new SqliteBindingError("SQLite query failed", {
				code: "sqlite_query_error",
			});
		}
	}

	async first(columnName) {
		const result = this.execute();
		const row = result.results[0] || null;
		if (!row || columnName === undefined) return row;
		return Object.hasOwn(row, columnName) ? row[columnName] : null;
	}

	async all() {
		return this.execute();
	}

	async run() {
		return this.execute();
	}
}

function normalizedResult(results, meta) {
	return {
		results: Array.isArray(results)
			? results.map((row) =>
					row && typeof row === "object" && !Array.isArray(row)
						? { ...row }
						: row,
				)
			: [],
		success: true,
		meta,
	};
}

function isMutationSql(sql) {
	return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
}

function safeInteger(value) {
	if (typeof value === "bigint") {
		const number = Number(value);
		return Number.isSafeInteger(number) ? number : undefined;
	}
	return Number.isSafeInteger(value) ? value : undefined;
}

function positiveInteger(value, fallback) {
	const raw = clean(value);
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new SqliteBindingError(
			"SQLITE_BUSY_TIMEOUT_MS must be a positive integer",
			{ code: "sqlite_invalid_busy_timeout" },
		);
	}
	return parsed;
}

function clean(value) {
	return String(value || "").trim();
}
