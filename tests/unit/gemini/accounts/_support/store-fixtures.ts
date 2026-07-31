import { isDeepStrictEqual } from "node:util";
import type { GeminiAccountSummary } from "../../../../../src/gemini/accounts/types";
import type { GeminiAccountIssue } from "../../../../../src/gemini/accounts/domain";
import type { GeminiAccountStore } from "../../../../../src/gemini/accounts/types";
import type {
	SqlDatabaseLike,
	SqlPreparedStatementLike,
	SqlResult,
	GeminiAccountRow,
} from "../../../../../src/gemini/accounts/types";
import type { GeminiAccountSummarySqlRow } from "../../../../../src/gemini/accounts/store-sql";

type SqlExpectation = string | RegExp;
type SQLOperation = "first" | "all" | "run" | "batch" | "aborted";

export type SQLExpectation = {
	sql: SqlExpectation;
	binds: readonly unknown[];
	operation: SQLOperation;
	result?: unknown;
	error?: unknown;
	columnName?: string;
};

type RecordingSqlRecord = {
	sql: string;
	binds: unknown[] | null;
	operation: SQLOperation | null;
};

export function accountSqlRow(
	id: string,
	overrides: Partial<GeminiAccountRow> = {},
): GeminiAccountRow {
	return {
		id,
		label: null,
		enabled: 1,
		cookie_header: `__Secure-1PSID=secret-p-${id}; __Secure-1PSIDTS=secret-t-${id}`,
		cookie_hash: `hash-${id}`,
		identity_hash: `identity-${id}`,
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		account_status_code: null,
		status_checked_at_ms: null,
		last_refresh_attempt_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: 1000,
		updated_at_ms: 1000,
		...overrides,
	};
}

export function accountSummary(
	id: string,
	overrides: Partial<GeminiAccountSummary> = {},
): GeminiAccountSummary {
	return {
		id,
		label: null,
		enabled: true,
		state: "available",
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		status_checked_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: 1000,
		updated_at_ms: 1000,
		browser: {
			credentialsConfigured: false,
			state: "idle",
			lastCheckAtMs: null,
			lastCookieUpdateAtMs: null,
			lastAutoLoginAtMs: null,
			failureCode: null,
		},
		...overrides,
	};
}

export function adminSqlRow(
	id: string,
	overrides: Partial<GeminiAccountSummarySqlRow> = {},
): GeminiAccountSummarySqlRow {
	const row = accountSqlRow(id, overrides);
	return {
		id: row.id,
		label: row.label,
		enabled: row.enabled,
		issue: row.issue,
		cooldown_until_ms: row.cooldown_until_ms,
		last_issue_at_ms: row.last_issue_at_ms,
		last_used_at_ms: row.last_used_at_ms,
		last_refresh_at_ms: row.last_refresh_at_ms,
		status_checked_at_ms: row.status_checked_at_ms,
		last_refresh_success_at_ms: row.last_refresh_success_at_ms,
		created_at_ms: row.created_at_ms,
		updated_at_ms: row.updated_at_ms,
		credentials_configured: 0,
		browser_state: "idle",
		last_check_at_ms: null,
		last_cookie_update_at_ms: null,
		last_auto_login_at_ms: null,
		failure_code: null,
	};
}

export const durableIssues = [
	"auth",
	"user_action",
	"location",
] as const satisfies readonly GeminiAccountIssue[];

const poolVersionSql = {
	changes:
		/INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? WHERE changes\(\) > 0 ON CONFLICT\(key\) DO UPDATE SET/,
	insertedRows:
		/INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? WHERE EXISTS \( SELECT 1 FROM gemini_accounts WHERE id IN \(.*\) \) ON CONFLICT\(key\) DO UPDATE SET/,
	unconditional:
		/INSERT INTO gemini_pool_meta .*SELECT \?, '1', \? ON CONFLICT\(key\) DO UPDATE SET/,
};

export function poolVersionExpectation(
	nowMs: number,
	mode: keyof typeof poolVersionSql = "changes",
	extraBinds: readonly unknown[] = [],
): SQLExpectation {
	return {
		sql: poolVersionSql[mode],
		binds: ["pool_version", nowMs, ...extraBinds],
		operation: "batch",
		result: { meta: { changes: 1 } },
	};
}

export function mutationResult(changes = 1): SqlResult {
	return { meta: { changes } };
}

export class RecordingSql implements SqlDatabaseLike {
	readonly pending: SQLExpectation[];
	readonly records: RecordingSqlRecord[] = [];
	readonly batches: RecordingSqlRecord[][] = [];

	constructor(expectations: readonly SQLExpectation[] = []) {
		this.pending = [...expectations];
	}

	prepare(sql: string): SqlPreparedStatementLike {
		const expectation = this.pending.shift();
		if (!expectation)
			throw new Error(`unexpected SQL prepare: ${normalizeSql(sql)}`);
		const normalized = normalizeSql(sql);
		assertSql(expectation.sql, normalized);
		const record = { sql: normalized, binds: null, operation: null };
		this.records.push(record);
		return new RecordingStatement(this, expectation, record);
	}

	async batch<T = unknown>(
		statements: SqlPreparedStatementLike[],
	): Promise<SqlResult<T>[]> {
		if (!Array.isArray(statements))
			throw new Error("SQL batch must be an array");
		this.batches.push(
			statements.map((statement) => {
				if (!(statement instanceof RecordingStatement) || statement.db !== this)
					throw new Error("SQL batch received an unrecorded statement");
				return statement.record;
			}),
		);
		const results: SqlResult<T>[] = [];
		for (let index = 0; index < statements.length; index++) {
			const statement = statements[index];
			if (!(statement instanceof RecordingStatement) || statement.db !== this)
				throw new Error("SQL batch received an unrecorded statement");
			try {
				results.push(statement.execute<SqlResult<T>>("batch"));
			} catch (error) {
				for (const pending of statements.slice(index + 1)) {
					if (!(pending instanceof RecordingStatement) || pending.db !== this)
						throw new Error("SQL batch received an unrecorded statement");
					pending.abort();
				}
				throw error;
			}
		}
		return results;
	}

	async guardedBatch<T = unknown>(
		guard: SqlPreparedStatementLike,
		statements: SqlPreparedStatementLike[],
	): Promise<{ committed: boolean; results: SqlResult<T>[] }> {
		if (!(guard instanceof RecordingStatement) || guard.db !== this)
			throw new Error("SQL guarded batch received an unrecorded guard");
		this.batches.push(
			[guard, ...statements].map((statement) => {
				if (!(statement instanceof RecordingStatement) || statement.db !== this)
					throw new Error("SQL guarded batch received an unrecorded statement");
				return statement.record;
			}),
		);
		const guardResult = guard.execute<SqlResult<T>>("batch");
		if (guardResult.results?.length !== 1) {
			for (const statement of statements) {
				if (!(statement instanceof RecordingStatement) || statement.db !== this)
					throw new Error("SQL guarded batch received an unrecorded statement");
				statement.abort();
			}
			return { committed: false, results: [] };
		}
		const results = [guardResult];
		for (const statement of statements) {
			if (!(statement instanceof RecordingStatement) || statement.db !== this)
				throw new Error("SQL guarded batch received an unrecorded statement");
			results.push(statement.execute<SqlResult<T>>("batch"));
		}
		return { committed: true, results };
	}

	assertBatches(expectedRecordIndexes: readonly (readonly number[])[]): void {
		const actualRecordIndexes = this.batches.map((batch) =>
			batch.map((record) => this.records.indexOf(record)),
		);
		assertValues(
			expectedRecordIndexes,
			actualRecordIndexes,
			"SQL batch groups",
		);
	}

	assertDrained(): void {
		if (this.pending.length) {
			throw new Error(
				`unconsumed SQL expectations: ${this.pending
					.map((item) => String(item.sql))
					.join(", ")}`,
			);
		}
		const incomplete = this.records.find((record) => record.operation === null);
		if (incomplete)
			throw new Error(
				`prepared SQL statement was not executed: ${incomplete.sql}`,
			);
	}

	get lastStatement(): RecordingSqlRecord | undefined {
		return this.records.at(-1);
	}
}

class RecordingStatement implements SqlPreparedStatementLike {
	constructor(
		readonly db: RecordingSql,
		private readonly expectation: SQLExpectation,
		readonly record: RecordingSqlRecord,
	) {}

	bind(...values: unknown[]): SqlPreparedStatementLike {
		if (this.record.binds !== null)
			throw new Error(`SQL statement was bound twice: ${this.record.sql}`);
		assertValues(this.expectation.binds, values, this.record.sql);
		this.record.binds = values;
		return this;
	}

	async first<T = unknown>(columnName?: string): Promise<T | null> {
		if (this.expectation.columnName !== undefined)
			assertValues(
				[this.expectation.columnName],
				[columnName],
				`${this.record.sql} column`,
			);
		return this.execute<T | null>("first");
	}

	async all<T = unknown>(): Promise<SqlResult<T>> {
		return this.execute<SqlResult<T>>("all");
	}

	async run<T = unknown>(): Promise<SqlResult<T>> {
		return this.execute<SqlResult<T>>("run");
	}

	execute<T>(operation: SQLOperation): T {
		if (this.record.operation !== null)
			throw new Error(`SQL statement executed twice: ${this.record.sql}`);
		if (this.record.binds === null) {
			assertValues(this.expectation.binds, [], this.record.sql);
			this.record.binds = [];
		}
		if (this.expectation.operation !== operation) {
			throw new Error(
				`unexpected SQL operation for ${this.record.sql}: expected ${this.expectation.operation}, received ${operation}`,
			);
		}
		this.record.operation = operation;
		if (Object.hasOwn(this.expectation, "error")) throw this.expectation.error;
		return this.expectation.result as T;
	}

	abort(): void {
		if (this.record.operation !== null)
			throw new Error(
				`SQL statement aborted after execution: ${this.record.sql}`,
			);
		if (this.record.binds === null) {
			assertValues(this.expectation.binds, [], this.record.sql);
			this.record.binds = [];
		}
		this.record.operation = "aborted";
	}
}

const ACCOUNT_STORE_METHODS = [
	"getPoolVersion",
	"listSelectableAccounts",
	"getAccountForRefresh",
	"getBrowserCandidateAccount",
	"replaceVerifiedBrowserCookie",
	"tryAcquireRefreshLock",
	"releaseRefreshLock",
	"writeRefreshedCookie",
	"writeAccountOutcome",
	"writeAccountProbe",
	"listAccountCapabilities",
	"listAllAccountCapabilities",
	"listModelRoutePriorities",
	"replaceModelRoutePriority",
	"clearModelRoutePriority",
	"getAdminOverview",
	"findAccountByCookieHash",
	"findAccountByIdentityHash",
	"createAccount",
	"importAccountByIdentity",
	"createAccountsBulk",
	"updateAccount",
	"deleteAccount",
	"setAccountsEnabledBulk",
	"deleteAccountsBulk",
] as const;

type CompleteAccountStore = GeminiAccountStore;
type StoreMethod = {
	[K in keyof CompleteAccountStore]: CompleteAccountStore[K] extends (
		...args: infer _Args
	) => unknown
		? K
		: never;
}[keyof CompleteAccountStore];
type StoreMethodArgs<K extends StoreMethod> = CompleteAccountStore[K] extends (
	...args: infer Args
) => unknown
	? Args
	: never;
type StoreMethodResult<K extends StoreMethod> =
	CompleteAccountStore[K] extends (...args: never[]) => Promise<infer Result>
		? Result
		: never;
type StoreMethodExpectation<K extends StoreMethod> = {
	args?: StoreMethodArgs<K>;
	check?: (args: StoreMethodArgs<K>) => void;
	run?: (
		args: StoreMethodArgs<K>,
	) => StoreMethodResult<K> | Promise<StoreMethodResult<K>>;
	result?: StoreMethodResult<K>;
	error?: unknown;
};
type AccountStoreExpectations = {
	[K in StoreMethod]?: StoreMethodExpectation<K> | StoreMethodExpectation<K>[];
};
type AccountStoreCall = {
	method: StoreMethod;
	args: readonly unknown[];
};
type AccountStoreDouble = GeminiAccountStore & {
	calls: AccountStoreCall[];
	assertDrained(): void;
};

export function createAccountStoreDouble(
	expectations: AccountStoreExpectations = {},
): AccountStoreDouble {
	const offsets = new Map<StoreMethod, number>();
	const calls: AccountStoreCall[] = [];

	async function invoke<K extends StoreMethod>(
		method: K,
		args: StoreMethodArgs<K>,
	): Promise<StoreMethodResult<K>> {
		const entries = expectationEntries(expectations[method]);
		const offset = offsets.get(method) ?? 0;
		const expectation = entries[offset];
		if (!expectation)
			throw new Error(`unexpected account store call: ${method}`);
		offsets.set(method, offset + 1);
		calls.push({ method, args });
		if (Object.hasOwn(expectation, "args"))
			assertValues(expectation.args, args, `account store ${method}`);
		if (expectation.check) expectation.check(args);
		if (Object.hasOwn(expectation, "error")) throw expectation.error;
		if (expectation.run) return expectation.run(args);
		return expectation.result as StoreMethodResult<K>;
	}

	const store: AccountStoreDouble = {
		calls,
		getPoolVersion: () => invoke("getPoolVersion", []),
		listSelectableAccounts: (nowMs, limit) =>
			invoke("listSelectableAccounts", [nowMs, limit]),
		getAccountForRefresh: (accountId) =>
			invoke("getAccountForRefresh", [accountId]),
		getBrowserCandidateAccount: (accountId) =>
			invoke("getBrowserCandidateAccount", [accountId]),
		replaceVerifiedBrowserCookie: (accountId, write) =>
			invoke("replaceVerifiedBrowserCookie", [accountId, write]),
		tryAcquireRefreshLock: (accountId, owner, expiresAtMs, nowMs) =>
			invoke("tryAcquireRefreshLock", [accountId, owner, expiresAtMs, nowMs]),
		releaseRefreshLock: (accountId, owner) =>
			invoke("releaseRefreshLock", [accountId, owner]),
		writeRefreshedCookie: (accountId, update) =>
			invoke("writeRefreshedCookie", [accountId, update]),
		writeAccountOutcome: (accountId, outcome) =>
			invoke("writeAccountOutcome", [accountId, outcome]),
		writeAccountProbe: (accountId, probe, checkedAtMs) =>
			invoke("writeAccountProbe", [accountId, probe, checkedAtMs]),
		listAccountCapabilities: (accountIds) =>
			invoke("listAccountCapabilities", [accountIds]),
		listAllAccountCapabilities: (limit) =>
			invoke("listAllAccountCapabilities", [limit]),
		listModelRoutePriorities: () => invoke("listModelRoutePriorities", []),
		replaceModelRoutePriority: (family, routes, nowMs) =>
			invoke("replaceModelRoutePriority", [family, routes, nowMs]),
		clearModelRoutePriority: (family, nowMs) =>
			invoke("clearModelRoutePriority", [family, nowMs]),
		getAdminOverview: (filter, nowMs) =>
			invoke("getAdminOverview", [filter, nowMs]),
		findAccountByCookieHash: (cookieHash, nowMs) =>
			invoke("findAccountByCookieHash", [cookieHash, nowMs]),
		findAccountByIdentityHash: (identityHash, nowMs) =>
			invoke("findAccountByIdentityHash", [identityHash, nowMs]),
		createAccount: (input) => invoke("createAccount", [input]),
		importAccountByIdentity: (entry) =>
			invoke("importAccountByIdentity", [entry]),
		createAccountsBulk: (entries) => invoke("createAccountsBulk", [entries]),
		updateAccount: (accountId, update) =>
			invoke("updateAccount", [accountId, update]),
		deleteAccount: (accountId, nowMs) =>
			invoke("deleteAccount", [accountId, nowMs]),
		setAccountsEnabledBulk: (accountIds, enabled, nowMs) =>
			invoke("setAccountsEnabledBulk", [accountIds, enabled, nowMs]),
		deleteAccountsBulk: (accountIds, nowMs) =>
			invoke("deleteAccountsBulk", [accountIds, nowMs]),
		assertDrained: () => {
			const remaining = ACCOUNT_STORE_METHODS.flatMap((method) => {
				const entries = expectationEntries(expectations[method]);
				const count = entries.length - (offsets.get(method) ?? 0);
				return count > 0 ? [`${method}(${count})`] : [];
			});
			if (remaining.length)
				throw new Error(
					`unconsumed account store calls: ${remaining.join(", ")}`,
				);
		},
	};
	return store;
}

function expectationEntries<K extends StoreMethod>(
	value: StoreMethodExpectation<K> | StoreMethodExpectation<K>[] | undefined,
): StoreMethodExpectation<K>[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function normalizeSql(sql: string): string {
	return String(sql).replace(/\s+/g, " ").trim();
}

function assertSql(expected: SqlExpectation, actual: string): void {
	if (expected instanceof RegExp) {
		expected.lastIndex = 0;
		if (expected.test(actual)) return;
	} else if (normalizeSql(expected) === actual) return;
	throw new Error(
		`unexpected SQL SQL: expected ${String(expected)}, received ${actual}`,
	);
}

function assertValues(
	expected: unknown,
	actual: unknown,
	context: string,
): void {
	if (isDeepStrictEqual(expected, actual)) return;
	throw new Error(
		`unexpected values for ${context}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
	);
}
