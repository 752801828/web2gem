import { uuid } from "../../shared/crypto";
import { isRecord } from "../../shared/types";
import {
	changedRows,
	identityHashFromCookie,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./domain";
import type {
	D1DatabaseLike,
	D1PreparedStatementLike,
	D1Result,
	GeminiAccountCreateInput,
	GeminiAccountRow,
} from "./types";

const ACCOUNT_INSERT_COLUMNS = [
	"id",
	"label",
	"enabled",
	"cookie_header",
	"cookie_hash",
	"identity_hash",
	"issue",
	"cooldown_until_ms",
	"last_issue_at_ms",
	"last_used_at_ms",
	"last_refresh_at_ms",
	"account_status_code",
	"status_checked_at_ms",
	"last_refresh_attempt_at_ms",
	"last_refresh_success_at_ms",
	"created_at_ms",
	"updated_at_ms",
] as const satisfies readonly (keyof GeminiAccountRow)[];

const ACCOUNT_INSERT_SQL = `
  INSERT INTO gemini_accounts (${ACCOUNT_INSERT_COLUMNS.join(", ")})
  VALUES (${ACCOUNT_INSERT_COLUMNS.map(() => "?").join(", ")})
`;

export const ACCOUNT_UPSERT_IDENTITY_SQL = `${ACCOUNT_INSERT_SQL}
	ON CONFLICT(identity_hash) DO UPDATE SET
		label = excluded.label,
		cookie_header = excluded.cookie_header,
		cookie_hash = excluded.cookie_hash,
		updated_at_ms = excluded.updated_at_ms
	WHERE gemini_accounts.cookie_hash <> excluded.cookie_hash
`;

export async function buildAccountInsertRow(
	input: GeminiAccountCreateInput,
	cookieHash?: string,
): Promise<GeminiAccountRow> {
	const cookieHeader = normalizeGeminiCookieHeader(input.cookieHeader);
	return {
		id: input.id || uuid(),
		label: input.label || null,
		enabled: 1,
		cookie_header: cookieHeader,
		cookie_hash: cookieHash || (await sha256Hex(cookieHeader)),
		identity_hash:
			input.identityHash || (await identityHashFromCookie(cookieHeader)),
		issue: null,
		cooldown_until_ms: null,
		last_issue_at_ms: null,
		last_used_at_ms: null,
		last_refresh_at_ms: null,
		account_status_code: null,
		status_checked_at_ms: null,
		last_refresh_attempt_at_ms: null,
		last_refresh_success_at_ms: null,
		created_at_ms: input.nowMs,
		updated_at_ms: input.nowMs,
	};
}

export function accountRowValues(row: GeminiAccountRow): unknown[] {
	return ACCOUNT_INSERT_COLUMNS.map((column) => row[column]);
}

export function valueOrCurrent<T>(next: T | undefined, current: T): T {
	return next === undefined ? current : next;
}

export const MAX_D1_BOUND_PARAMETERS = 100;
export const MAX_TRANSACTIONAL_ACCOUNT_IMPORTS = 40;

export type AccountImportWriteFacts = {
	mutatedCookieHashes: ReadonlySet<string>;
	createdIdentityHashes: ReadonlySet<string>;
	preexistingIds: ReadonlyMap<string, string>;
	batched: boolean;
};

export type AccountImportStore = {
	db: D1DatabaseLike;
	bumpPoolVersion: (nowMs: number) => Promise<void>;
	poolVersionIncrementBeforeImports: (
		nowMs: number,
		rows: readonly GeminiAccountRow[],
	) => D1PreparedStatementLike;
};

export async function writeAccountImports(
	store: AccountImportStore,
	rows: readonly GeminiAccountRow[],
): Promise<AccountImportWriteFacts> {
	const mutatedCookieHashes = new Set<string>();
	const batch = store.db.batch?.bind(store.db);
	const batched = batch !== undefined;
	const createdIdentityHashes = new Set<string>();
	const preexistingIds = new Map<string, string>();
	for (
		let offset = 0;
		offset < rows.length;
		offset += MAX_TRANSACTIONAL_ACCOUNT_IMPORTS
	) {
		const chunk = rows.slice(
			offset,
			offset + MAX_TRANSACTIONAL_ACCOUNT_IMPORTS,
		);
		const statements: D1PreparedStatementLike[] = [];
		const nowMs = chunk[0]?.updated_at_ms ?? Date.now();
		const fallbackPreexistingIds = batched
			? null
			: await findImportPreexistingIds(store.db, chunk);
		if (batched) {
			// The leading write owns the D1 batch transaction before it reads
			// pre-upsert pairs, so concurrent imports cannot share a stale view.
			statements.push(store.poolVersionIncrementBeforeImports(nowMs, chunk));
		}
		const resultIndexes: { row: GeminiAccountRow; statement: number }[] = [];
		for (const row of chunk) {
			const statement = statements.length;
			statements.push(
				store.db
					.prepare(ACCOUNT_UPSERT_IDENTITY_SQL)
					.bind(...accountRowValues(row)),
			);
			resultIndexes.push({ row, statement });
		}
		const results = batch
			? await batch(statements)
			: await runStatements(statements);
		if (results.length !== statements.length)
			throw new Error("D1 account import batch returned incomplete results");
		const preexistingIdsForChunk = batched
			? readImportPreexistingIds(results[0], chunk)
			: fallbackPreexistingIds;
		for (const [identityHash, id] of preexistingIdsForChunk || [])
			if (id !== null) preexistingIds.set(identityHash, id);
		let chunkChanged = false;
		for (const indexes of resultIndexes) {
			const result = results[indexes.statement];
			if (!result) throw new Error("D1 account import result was missing");
			if (importResultChanged(result) > 0) {
				chunkChanged = true;
				mutatedCookieHashes.add(indexes.row.cookie_hash);
				if (
					batched &&
					preexistingIdsForChunk?.get(indexes.row.identity_hash) === null
				)
					createdIdentityHashes.add(indexes.row.identity_hash);
			}
		}
		if (batched && chunkChanged && preexistingIdsForChunk?.size === 0)
			throw new Error("D1 account import prestate did not report a mutation");
		if (!batched && chunkChanged) await store.bumpPoolVersion(nowMs);
	}
	return {
		mutatedCookieHashes,
		createdIdentityHashes,
		preexistingIds,
		batched,
	};
}

export function importWasCreated(
	facts: AccountImportWriteFacts,
	row: GeminiAccountRow,
	canonicalId: string,
): boolean {
	if (facts.createdIdentityHashes.has(row.identity_hash)) return true;
	if (facts.batched) return false;
	const preexistingId = facts.preexistingIds.get(row.identity_hash);
	if (preexistingId === undefined) return canonicalId === row.id;
	return canonicalId === row.id && canonicalId !== preexistingId;
}

export function buildPoolVersionIncrementBeforeImportsSql(
	nowMs: number,
	rows: readonly GeminiAccountRow[],
	poolVersionIncrementStatement: (
		nowMs: number,
		condition?: string,
		conditionValues?: readonly unknown[],
		options?: {
			prefix?: string;
			prefixValues?: readonly unknown[];
			returning?: string;
		},
	) => D1PreparedStatementLike,
): D1PreparedStatementLike {
	const uniquePairs = new Map<
		string,
		{ identityHash: string; cookieHash: string }
	>();
	for (const row of rows) {
		uniquePairs.set(`${row.identity_hash}\0${row.cookie_hash}`, {
			identityHash: row.identity_hash,
			cookieHash: row.cookie_hash,
		});
	}
	const pairs = [...uniquePairs.values()];
	const requestedPairs = JSON.stringify(
		pairs.map((pair) => [pair.identityHash, pair.cookieHash]),
	);
	return poolVersionIncrementStatement(
		nowMs,
		`WHERE EXISTS (
					SELECT 1 FROM requested AS requested_pair
					LEFT JOIN gemini_accounts AS account
						ON account.identity_hash = requested_pair.identity_hash
						AND account.cookie_hash = requested_pair.cookie_hash
					WHERE account.id IS NULL
				)`,
		[],
		{
			prefix: `WITH requested(identity_hash, cookie_hash) AS (
						SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
						FROM json_each(?)
					)`,
			prefixValues: [requestedPairs],
			returning: `RETURNING (
						SELECT json_group_object(requested_pair.identity_hash, account.id)
						FROM requested AS requested_pair
						LEFT JOIN gemini_accounts AS account
							ON account.identity_hash = requested_pair.identity_hash
					) AS preexisting_ids`,
		},
	);
}

async function runStatements(
	statements: readonly D1PreparedStatementLike[],
): Promise<D1Result[]> {
	const results: D1Result[] = [];
	for (const statement of statements) results.push(await statement.run());
	return results;
}

async function findImportPreexistingIds(
	db: D1DatabaseLike,
	rows: readonly GeminiAccountRow[],
): Promise<Map<string, string | null>> {
	const identityHashes = [...new Set(rows.map((row) => row.identity_hash))];
	const ids = new Map<string, string | null>(
		identityHashes.map((identityHash) => [identityHash, null]),
	);
	for (
		let offset = 0;
		offset < identityHashes.length;
		offset += MAX_D1_BOUND_PARAMETERS
	) {
		const chunk = identityHashes.slice(
			offset,
			offset + MAX_D1_BOUND_PARAMETERS,
		);
		const placeholders = chunk.map(() => "?").join(", ");
		const result = await db
			.prepare(`
						SELECT identity_hash, id FROM gemini_accounts
						WHERE identity_hash IN (${placeholders})
					`)
			.bind(...chunk)
			.all<{ identity_hash: string; id: string }>();
		for (const row of result.results || []) ids.set(row.identity_hash, row.id);
	}
	return ids;
}

function readImportPreexistingIds(
	result: D1Result | undefined,
	rows: readonly GeminiAccountRow[],
): Map<string, string | null> {
	if (!result) throw new Error("D1 account import version result was missing");
	if (importResultChanged(result) === 0) return new Map();
	const returned = result.results?.[0];
	if (!isRecord(returned) || typeof returned.preexisting_ids !== "string")
		throw new Error("D1 account import prestate result was missing");
	let parsed: unknown;
	try {
		parsed = JSON.parse(returned.preexisting_ids);
	} catch {
		throw new Error("D1 account import prestate result was invalid");
	}
	if (!isRecord(parsed))
		throw new Error("D1 account import prestate result was invalid");
	const ids = new Map<string, string | null>();
	for (const row of rows) {
		if (!Object.hasOwn(parsed, row.identity_hash))
			throw new Error("D1 account import prestate identity was missing");
		const id = parsed[row.identity_hash];
		if (id !== null && typeof id !== "string")
			throw new Error("D1 account import prestate identity was invalid");
		ids.set(row.identity_hash, id);
	}
	return ids;
}

function importResultChanged(result: D1Result): number {
	const changed = changedRows(result.meta);
	if (changed === null)
		throw new Error("D1 account import result did not report changed rows");
	return changed;
}
