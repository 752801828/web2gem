import {
	boundedGeminiAccountPageLimit,
	GEMINI_DURABLE_ACCOUNT_ISSUES,
	type GeminiAccountIssue,
	geminiAccountState,
	resultChanged,
	visibleGeminiAccountIssue,
} from "./domain";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
	GeminiAccountAdminFilter,
	GeminiAccountAdminOverview,
	GeminiAccountAdminStats,
	GeminiAccountBulkCreateEntry,
	GeminiAccountBulkCreateResult,
	GeminiAccountCreateInput,
	GeminiAccountIdentityImportResult,
	GeminiAccountRow,
	GeminiAccountStore,
	GeminiAccountSummary,
	GeminiAccountSummaryPage,
	GeminiAccountUpdate,
	GeminiAccountUpdateResult,
} from "./types";
import {
	buildAccountInsertRow,
	buildPoolVersionIncrementBeforeImportsSql,
	importWasCreated,
	MAX_D1_BOUND_PARAMETERS,
	valueOrCurrent,
	writeAccountImports,
} from "./store-d1-import";
import { D1GeminiAccountStoreBase } from "./store-d1-runtime";

export const ADMIN_ACCOUNT_SELECT = `
  id, label, enabled, issue, cooldown_until_ms, last_issue_at_ms,
  last_used_at_ms, last_refresh_at_ms, status_checked_at_ms,
  last_refresh_success_at_ms, created_at_ms, updated_at_ms
`;

export type GeminiAccountSummarySqlRow = {
	id: string;
	label: string | null;
	enabled: number;
	issue: GeminiAccountIssue | null;
	cooldown_until_ms: number | null;
	last_issue_at_ms: number | null;
	last_used_at_ms: number | null;
	last_refresh_at_ms: number | null;
	status_checked_at_ms: number | null;
	last_refresh_success_at_ms: number | null;
	created_at_ms: number;
	updated_at_ms: number;
};

export function adminWhere(
	filter: Partial<GeminiAccountAdminFilter>,
	nowMs: number,
): { where: string[]; args: unknown[] } {
	const args: unknown[] = [];
	const where: string[] = [];
	if (filter.cursor) {
		where.push("id > ?");
		args.push(filter.cursor);
	}
	if (filter.state === "disabled") {
		where.push("enabled != 1");
	} else if (filter.state === "cooling") {
		where.push("enabled = 1 AND cooldown_until_ms > ?");
		args.push(nowMs);
	} else if (filter.state === "attention") {
		where.push(
			`enabled = 1 AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?) AND issue IN (${GEMINI_DURABLE_ACCOUNT_ISSUES.map(() => "?").join(", ")})`,
		);
		args.push(nowMs, ...GEMINI_DURABLE_ACCOUNT_ISSUES);
	} else if (filter.state === "available") {
		where.push(
			`enabled = 1 AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?) AND (issue IS NULL OR issue NOT IN (${GEMINI_DURABLE_ACCOUNT_ISSUES.map(() => "?").join(", ")}))`,
		);
		args.push(nowMs, ...GEMINI_DURABLE_ACCOUNT_ISSUES);
	}
	if (filter.q) {
		const like = `%${escapeSqlLike(filter.q)}%`;
		where.push(
			"(id LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\' OR issue LIKE ? ESCAPE '\\')",
		);
		args.push(like, like, like);
	}
	return { where, args };
}

export function summaryFromSql(
	row: GeminiAccountSummarySqlRow,
	nowMs: number,
): GeminiAccountSummary {
	return {
		id: row.id,
		label: row.label,
		enabled: row.enabled === 1,
		state: geminiAccountState(row, nowMs),
		issue: visibleGeminiAccountIssue(row, nowMs),
		cooldown_until_ms: row.cooldown_until_ms,
		last_issue_at_ms: row.last_issue_at_ms,
		last_used_at_ms: row.last_used_at_ms,
		last_refresh_at_ms: row.last_refresh_at_ms,
		status_checked_at_ms: row.status_checked_at_ms,
		last_refresh_success_at_ms: row.last_refresh_success_at_ms,
		created_at_ms: row.created_at_ms,
		updated_at_ms: row.updated_at_ms,
	};
}

function numberOrZero(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

export function adminPageFromRows(
	rows: GeminiAccountSummarySqlRow[],
	requestedLimit: number,
	nowMs: number,
): GeminiAccountSummaryPage {
	const limit = boundedGeminiAccountPageLimit(requestedLimit);
	const pageRows = rows.slice(0, limit);
	return {
		items: pageRows.map((row) => summaryFromSql(row, nowMs)),
		nextCursor:
			rows.length > limit ? pageRows[pageRows.length - 1]?.id || null : null,
		limit,
	};
}

export function adminStatsFromRow(
	row: Partial<GeminiAccountAdminStats> | null | undefined,
): GeminiAccountAdminStats {
	return {
		total: numberOrZero(row?.total),
		available: numberOrZero(row?.available),
		cooling: numberOrZero(row?.cooling),
		attention: numberOrZero(row?.attention),
		disabled: numberOrZero(row?.disabled),
	};
}

function escapeSqlLike(value: string): string {
	return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export class D1GeminiAccountStore
	extends D1GeminiAccountStoreBase
	implements GeminiAccountStore
{
	constructor(db: D1DatabaseLike) {
		super(db);
	}

	async getAdminOverview(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountAdminOverview> {
		if (!this.db.batch) {
			const [page, stats] = await Promise.all([
				this.listAdminAccounts(filter, nowMs),
				this.getAdminStats(nowMs),
			]);
			return { ...page, stats };
		}
		const [pageResult, statsResult] = await this.db.batch([
			this.adminPageStatement(filter, nowMs),
			this.adminStatsStatement(nowMs),
		]);
		if (!pageResult || !statsResult)
			throw new Error("D1 account overview batch returned incomplete results");
		return {
			...adminPageFromRows(
				(pageResult.results || []) as GeminiAccountSummarySqlRow[],
				filter.limit,
				nowMs,
			),
			stats: adminStatsFromRow(
				(statsResult.results?.[0] ||
					null) as Partial<GeminiAccountAdminStats> | null,
			),
		};
	}

	async findAccountByCookieHash(
		cookieHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null> {
		return this.findAccountSummaryByHash("cookie", cookieHash, nowMs);
	}

	async findAccountByIdentityHash(
		identityHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null> {
		return this.findAccountSummaryByHash("identity", identityHash, nowMs);
	}

	private async findAccountSummaryByHash(
		kind: "cookie" | "identity",
		hash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null> {
		const column = kind === "cookie" ? "cookie_hash" : "identity_hash";
		const row = await this.db
			.prepare(`
						SELECT ${ADMIN_ACCOUNT_SELECT}
						FROM gemini_accounts
						WHERE ${column} = ?
						LIMIT 1
					`)
			.bind(hash)
			.first<GeminiAccountSummarySqlRow>();
		return row ? summaryFromSql(row, nowMs) : null;
	}

	async createAccount(
		input: GeminiAccountCreateInput,
	): Promise<GeminiAccountSummary> {
		const row = await buildAccountInsertRow(input);
		await this.writeAccountImports([row]);
		const canonical = (
			await this.findAccountsByIdentityHashes([row.identity_hash], input.nowMs)
		).get(row.identity_hash);
		if (!canonical)
			throw new Error("D1 account import did not return a canonical identity");
		return canonical;
	}

	async importAccountByIdentity(
		entry: GeminiAccountBulkCreateEntry,
	): Promise<GeminiAccountIdentityImportResult> {
		const row = await buildAccountInsertRow(entry.input, entry.cookieHash);
		const facts = await this.writeAccountImports([row]);
		const canonical = (
			await this.findAccountsByIdentityHashes(
				[row.identity_hash],
				entry.input.nowMs,
			)
		).get(row.identity_hash);
		if (!canonical)
			throw new Error("D1 account import did not return a canonical identity");
		if (!facts.mutatedCookieHashes.has(row.cookie_hash))
			return { item: canonical, outcome: "unchanged" };
		const created = importWasCreated(facts, row, canonical.id);
		if (created) return { item: canonical, outcome: "created" };
		return {
			item: canonical,
			outcome: "credentials_changed",
		};
	}

	private writeAccountImports(rows: readonly GeminiAccountRow[]) {
		return writeAccountImports(
			{
				db: this.db,
				bumpPoolVersion: (nowMs) => this.bumpPoolVersion(nowMs),
				poolVersionIncrementBeforeImports: (nowMs, importRows) =>
					this.poolVersionIncrementBeforeImports(nowMs, importRows),
			},
			rows,
		);
	}

	private poolVersionIncrementBeforeImports(
		nowMs: number,
		rows: readonly GeminiAccountRow[],
	): D1PreparedStatementLike {
		return buildPoolVersionIncrementBeforeImportsSql(
			nowMs,
			rows,
			(versionNowMs, condition, conditionValues, options) =>
				this.poolVersionIncrementStatement(
					versionNowMs,
					condition,
					conditionValues,
					options,
				),
		);
	}

	async createAccountsBulk(
		entries: GeminiAccountBulkCreateEntry[],
	): Promise<GeminiAccountBulkCreateResult> {
		if (!entries.length)
			return {
				createdAccountIds: new Set(),
				changedCredentialCount: 0,
			};
		const rows = await Promise.all(
			entries.map((entry) =>
				buildAccountInsertRow(entry.input, entry.cookieHash),
			),
		);
		const facts = await this.writeAccountImports(rows);
		const canonicalIdByIdentity = await this.findAccountIdsByIdentityHashes(
			rows.map((row) => row.identity_hash),
		);
		const createdAccountIds = new Set<string>();
		let changedCredentialCount = 0;
		for (const row of rows) {
			const canonicalId = canonicalIdByIdentity.get(row.identity_hash);
			if (!canonicalId)
				throw new Error(
					"D1 account import did not return a canonical identity",
				);
			if (!facts.mutatedCookieHashes.has(row.cookie_hash)) continue;
			const created = importWasCreated(facts, row, canonicalId);
			if (created) {
				createdAccountIds.add(canonicalId);
			} else {
				changedCredentialCount += 1;
			}
		}
		return {
			createdAccountIds,
			changedCredentialCount,
		};
	}

	async updateAccount(
		accountId: string,
		update: GeminiAccountUpdate,
	): Promise<GeminiAccountUpdateResult> {
		const current = await this.getAccountRow(accountId);
		if (!current) return { item: null, changed: false };
		const label = valueOrCurrent(update.label, current.label);
		let enabled = current.enabled;
		if (update.enabled !== undefined) enabled = update.enabled ? 1 : 0;
		const changed = label !== current.label || enabled !== current.enabled;
		if (!changed)
			return { item: summaryFromSql(current, update.nowMs), changed: false };
		const statement = this.db
			.prepare(`
      UPDATE gemini_accounts
      SET label = ?, enabled = ?, updated_at_ms = ?
      WHERE id = ?
    `)
			.bind(label, enabled, update.nowMs, accountId);
		if (enabled !== current.enabled)
			await this.runMutationWithPoolVersion(statement, update.nowMs);
		else await statement.run();
		return {
			item: summaryFromSql(
				{ ...current, label, enabled, updated_at_ms: update.nowMs },
				update.nowMs,
			),
			changed: true,
		};
	}

	async deleteAccount(accountId: string, nowMs: number): Promise<boolean> {
		const result = await this.runMutationWithPoolVersion(
			this.db
				.prepare("DELETE FROM gemini_accounts WHERE id = ?")
				.bind(accountId),
			nowMs,
		);
		return resultChanged(result) > 0;
	}

	async setAccountsEnabledBulk(
		accountIds: readonly string[],
		enabled: boolean,
		nowMs: number,
	): Promise<string[]> {
		const rows = await this.getAccountRowsByIds(accountIds);
		const changedIds = rows
			.filter((row) => row.enabled !== (enabled ? 1 : 0))
			.map((row) => row.id);
		if (!changedIds.length) return [];
		const placeholders = changedIds.map(() => "?").join(", ");
		await this.runMutationWithPoolVersion(
			this.db
				.prepare(`
        UPDATE gemini_accounts
        SET enabled = ?, updated_at_ms = ?
        WHERE id IN (${placeholders})
      `)
				.bind(enabled ? 1 : 0, nowMs, ...changedIds),
			nowMs,
		);
		return changedIds;
	}

	async deleteAccountsBulk(
		accountIds: readonly string[],
		nowMs: number,
	): Promise<string[]> {
		const rows = await this.getAccountRowsByIds(accountIds);
		const existingIds = rows.map((row) => row.id);
		if (!existingIds.length) return [];
		const placeholders = existingIds.map(() => "?").join(", ");
		await this.runMutationWithPoolVersion(
			this.db
				.prepare(`DELETE FROM gemini_accounts WHERE id IN (${placeholders})`)
				.bind(...existingIds),
			nowMs,
		);
		return existingIds;
	}

	private async listAdminAccounts(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountSummaryPage> {
		const result = await this.adminPageStatement(
			filter,
			nowMs,
		).all<GeminiAccountSummarySqlRow>();
		return adminPageFromRows(result.results || [], filter.limit, nowMs);
	}

	private async getAdminStats(nowMs: number): Promise<GeminiAccountAdminStats> {
		const row =
			await this.adminStatsStatement(nowMs).first<
				Partial<GeminiAccountAdminStats>
			>();
		return adminStatsFromRow(row);
	}

	private adminPageStatement(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): D1PreparedStatementLike {
		const limit = boundedGeminiAccountPageLimit(filter.limit);
		const { where, args } = adminWhere(filter, nowMs);
		return this.db
			.prepare(`
      SELECT ${ADMIN_ACCOUNT_SELECT}
      FROM gemini_accounts
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id ASC
      LIMIT ?
    `)
			.bind(...args, limit + 1);
	}

	private adminStatsStatement(nowMs: number): D1PreparedStatementLike {
		const durable = GEMINI_DURABLE_ACCOUNT_ISSUES.map(() => "?").join(", ");
		return this.db
			.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN enabled = 1
          AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?)
          AND (issue IS NULL OR issue NOT IN (${durable})) THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN enabled = 1 AND cooldown_until_ms > ? THEN 1 ELSE 0 END) AS cooling,
        SUM(CASE WHEN enabled = 1
          AND (cooldown_until_ms IS NULL OR cooldown_until_ms <= ?)
          AND issue IN (${durable}) THEN 1 ELSE 0 END) AS attention,
        SUM(CASE WHEN enabled != 1 THEN 1 ELSE 0 END) AS disabled
      FROM gemini_accounts
    `)
			.bind(
				nowMs,
				...GEMINI_DURABLE_ACCOUNT_ISSUES,
				nowMs,
				nowMs,
				...GEMINI_DURABLE_ACCOUNT_ISSUES,
			);
	}

	private async findAccountsByIdentityHashes(
		identityHashes: readonly string[],
		nowMs: number,
	): Promise<Map<string, GeminiAccountSummary>> {
		const unique = [...new Set(identityHashes)];
		const items = new Map<string, GeminiAccountSummary>();
		for (
			let offset = 0;
			offset < unique.length;
			offset += MAX_D1_BOUND_PARAMETERS
		) {
			const chunk = unique.slice(offset, offset + MAX_D1_BOUND_PARAMETERS);
			if (!chunk.length) continue;
			const placeholders = chunk.map(() => "?").join(", ");
			const result = await this.db
				.prepare(`
							SELECT identity_hash, ${ADMIN_ACCOUNT_SELECT}
							FROM gemini_accounts
							WHERE identity_hash IN (${placeholders})
						`)
				.bind(...chunk)
				.all<GeminiAccountSummarySqlRow & { identity_hash: string }>();
			for (const row of result.results || [])
				items.set(row.identity_hash, summaryFromSql(row, nowMs));
		}
		return items;
	}

	private async findAccountIdsByIdentityHashes(
		identityHashes: readonly string[],
	): Promise<Map<string, string>> {
		const unique = [...new Set(identityHashes)];
		const ids = new Map<string, string>();
		for (
			let offset = 0;
			offset < unique.length;
			offset += MAX_D1_BOUND_PARAMETERS
		) {
			const chunk = unique.slice(offset, offset + MAX_D1_BOUND_PARAMETERS);
			if (!chunk.length) continue;
			const placeholders = chunk.map(() => "?").join(", ");
			const result = await this.db
				.prepare(`
							SELECT identity_hash, id
							FROM gemini_accounts
							WHERE identity_hash IN (${placeholders})
						`)
				.bind(...chunk)
				.all<{ identity_hash: string; id: string }>();
			for (const row of result.results || [])
				ids.set(row.identity_hash, row.id);
		}
		return ids;
	}
}
