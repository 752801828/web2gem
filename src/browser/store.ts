import type { SqlDatabaseLike } from "../gemini/accounts/types";
import type {
	BrowserAccountStatus,
	BrowserAccountStore,
	BrowserScheduleAccount,
	BrowserStatusUpdate,
	EncryptedBrowserCredentials,
} from "./types";
import { browserState } from "./types";

type StatusRow = {
	credentials_configured: number;
	browser_state: unknown;
	last_check_at_ms: number | null;
	last_cookie_update_at_ms: number | null;
	last_auto_login_at_ms: number | null;
	failure_code: unknown;
};

type ScheduleRow = StatusRow & {
	account_id: string;
	label: string | null;
	auth_failure_count: number;
	auto_login_attempt_date: string | null;
	auto_login_attempt_count: number;
};

type CredentialRow = {
	credential_ciphertext: unknown;
	credential_nonce: unknown;
	credential_version: unknown;
	login_email_hash: unknown;
};

const STATUS_SELECT = `
  credential_ciphertext IS NOT NULL
    AND credential_nonce IS NOT NULL
    AND credential_version = 1
    AND login_email_hash IS NOT NULL AS credentials_configured,
  browser_state, last_check_at_ms, last_cookie_update_at_ms,
  last_auto_login_at_ms, failure_code
`;

const MAX_FAILURE_CODE_LENGTH = 128;

function statusFromRow(row: StatusRow): BrowserAccountStatus {
	return {
		credentialsConfigured: row.credentials_configured === 1,
		state: browserState(row.browser_state),
		lastCheckAtMs: row.last_check_at_ms,
		lastCookieUpdateAtMs: row.last_cookie_update_at_ms,
		lastAutoLoginAtMs: row.last_auto_login_at_ms,
		failureCode: typeof row.failure_code === "string" ? row.failure_code : null,
	};
}

export class SqlBrowserAccountStore implements BrowserAccountStore {
	constructor(private readonly db: SqlDatabaseLike) {}

	async listScheduled(_nowMs: number): Promise<BrowserScheduleAccount[]> {
		const result = await this.db
			.prepare(`
        SELECT a.id AS account_id, a.label,
          COALESCE(b.credential_ciphertext IS NOT NULL
            AND b.credential_nonce IS NOT NULL
            AND b.credential_version = 1
            AND b.login_email_hash IS NOT NULL, 0) AS credentials_configured,
          COALESCE(b.browser_state, 'idle') AS browser_state,
          b.last_check_at_ms, b.last_cookie_update_at_ms,
          b.last_auto_login_at_ms, b.failure_code,
          COALESCE(b.auth_failure_count, 0) AS auth_failure_count,
          b.auto_login_attempt_date,
          COALESCE(b.auto_login_attempt_count, 0) AS auto_login_attempt_count
        FROM gemini_accounts a
        LEFT JOIN gemini_browser_accounts b ON b.account_id = a.id
        WHERE a.enabled = 1
        ORDER BY b.last_check_at_ms ASC, a.id ASC
      `)
			.all<ScheduleRow>();
		return (result.results || []).map((row) => ({
			accountId: row.account_id,
			label: row.label,
			status: statusFromRow(row),
			authFailureCount: row.auth_failure_count,
			autoLoginAttemptDate: row.auto_login_attempt_date,
			autoLoginAttemptCount: row.auto_login_attempt_count,
		}));
	}

	async getStatus(accountId: string): Promise<BrowserAccountStatus | null> {
		const row = await this.db
			.prepare(
				`SELECT ${STATUS_SELECT} FROM gemini_browser_accounts WHERE account_id = ? LIMIT 1`,
			)
			.bind(accountId)
			.first<StatusRow>();
		return row ? statusFromRow(row) : null;
	}

	async putCredentials(
		accountId: string,
		value: EncryptedBrowserCredentials,
		nowMs: number,
	): Promise<void> {
		await this.db
			.prepare(`
        INSERT INTO gemini_browser_accounts (
          account_id, credential_ciphertext, credential_nonce,
          credential_version, login_email_hash, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          credential_ciphertext = excluded.credential_ciphertext,
          credential_nonce = excluded.credential_nonce,
          credential_version = excluded.credential_version,
          login_email_hash = excluded.login_email_hash,
          updated_at_ms = excluded.updated_at_ms
      `)
			.bind(
				accountId,
				value.ciphertext,
				value.nonce,
				value.version,
				value.emailHash,
				nowMs,
			)
			.run();
	}

	async clearCredentials(accountId: string, nowMs: number): Promise<void> {
		await this.db
			.prepare(`
        INSERT INTO gemini_browser_accounts (account_id, updated_at_ms)
        VALUES (?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          credential_ciphertext = NULL,
          credential_nonce = NULL,
          credential_version = NULL,
          login_email_hash = NULL,
          updated_at_ms = excluded.updated_at_ms
      `)
			.bind(accountId, nowMs)
			.run();
	}

	async getEncryptedCredentials(
		accountId: string,
	): Promise<EncryptedBrowserCredentials | null> {
		const row = await this.db
			.prepare(`
        SELECT credential_ciphertext, credential_nonce,
          credential_version, login_email_hash
        FROM gemini_browser_accounts
        WHERE account_id = ?
        LIMIT 1
      `)
			.bind(accountId)
			.first<CredentialRow>();
		if (
			typeof row?.credential_ciphertext !== "string" ||
			!row.credential_ciphertext ||
			typeof row.credential_nonce !== "string" ||
			!row.credential_nonce ||
			row.credential_version !== 1 ||
			typeof row.login_email_hash !== "string" ||
			!row.login_email_hash
		)
			return null;
		return {
			version: 1,
			ciphertext: row.credential_ciphertext,
			nonce: row.credential_nonce,
			emailHash: row.login_email_hash,
		};
	}

	async tryAcquireLease(
		accountId: string,
		owner: string,
		expiresAtMs: number,
		nowMs: number,
	): Promise<boolean> {
		const result = await this.db
			.prepare(`
        INSERT INTO gemini_browser_accounts (
          account_id, lock_owner, lock_expires_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          lock_owner = excluded.lock_owner,
          lock_expires_at_ms = excluded.lock_expires_at_ms,
          updated_at_ms = excluded.updated_at_ms
        WHERE gemini_browser_accounts.lock_expires_at_ms IS NULL
          OR gemini_browser_accounts.lock_expires_at_ms <= ?
          OR gemini_browser_accounts.lock_owner = ?
        RETURNING account_id
      `)
			.bind(accountId, owner, expiresAtMs, nowMs, nowMs, owner)
			.run<{ account_id: unknown }>();
		return (
			result.results?.length === 1 &&
			result.results[0]?.account_id === accountId
		);
	}

	async releaseLease(accountId: string, owner: string): Promise<void> {
		await this.db
			.prepare(`
        UPDATE gemini_browser_accounts
        SET lock_owner = NULL, lock_expires_at_ms = NULL
        WHERE account_id = ? AND lock_owner = ?
      `)
			.bind(accountId, owner)
			.run();
	}

	async writeStatus(
		accountId: string,
		update: BrowserStatusUpdate,
	): Promise<void> {
		await this.db
			.prepare(`
        INSERT INTO gemini_browser_accounts (
          account_id, browser_state, last_check_at_ms,
          last_cookie_update_at_ms, last_auto_login_at_ms,
          auth_failure_count, notification_state, failure_code, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          browser_state = excluded.browser_state,
          last_check_at_ms = excluded.last_check_at_ms,
          last_cookie_update_at_ms = excluded.last_cookie_update_at_ms,
          last_auto_login_at_ms = excluded.last_auto_login_at_ms,
          auth_failure_count = excluded.auth_failure_count,
          notification_state = excluded.notification_state,
          failure_code = excluded.failure_code,
          updated_at_ms = excluded.updated_at_ms
      `)
			.bind(
				accountId,
				update.state,
				update.lastCheckAtMs,
				update.lastCookieUpdateAtMs,
				update.lastAutoLoginAtMs,
				update.authFailureCount,
				update.notificationState,
				update.failureCode?.slice(0, MAX_FAILURE_CODE_LENGTH) ?? null,
				update.nowMs,
			)
			.run();
	}

	async recordAutoLoginAttempt(
		accountId: string,
		date: string,
		nowMs: number,
	): Promise<number> {
		const result = await this.db
			.prepare(`
        INSERT INTO gemini_browser_accounts (
          account_id, auto_login_attempt_date,
          auto_login_attempt_count, updated_at_ms
        ) VALUES (?, ?, 1, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          auto_login_attempt_count = CASE
            WHEN gemini_browser_accounts.auto_login_attempt_date = excluded.auto_login_attempt_date
              THEN gemini_browser_accounts.auto_login_attempt_count + 1
            ELSE 1
          END,
          auto_login_attempt_date = excluded.auto_login_attempt_date,
          updated_at_ms = excluded.updated_at_ms
        RETURNING auto_login_attempt_count
      `)
			.bind(accountId, date, nowMs)
			.run<{ auto_login_attempt_count: number }>();
		const count = result.results?.[0]?.auto_login_attempt_count;
		if (
			result.results?.length !== 1 ||
			typeof count !== "number" ||
			!Number.isInteger(count) ||
			count < 1
		)
			throw new Error("SQL browser attempt update returned no count");
		return count;
	}
}
