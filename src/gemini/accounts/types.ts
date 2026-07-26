import type { GeminiPublicFamily } from "../../models";
import type {
	GeminiAccountIssue,
	GeminiAccountOutcome,
	GeminiAccountState,
} from "./domain";

export type { GeminiAccountOutcome };

import type {
	GeminiAccountCapabilityRow,
	GeminiKnownTierLabel,
	GeminiModelRoutePriorityRow,
	GeminiRouteTuple,
} from "./routes";

type D1ResultMeta = {
	changes?: number;
	changedRows?: number;
	rows_written?: number;
	rowsWritten?: number;
	last_row_id?: number;
};

export type D1Result<T = unknown> = {
	results?: T[];
	success?: boolean;
	meta?: D1ResultMeta;
};

export type D1DatabaseLike = {
	prepare(sql: string): D1PreparedStatementLike;
	batch?<T = unknown>(
		statements: D1PreparedStatementLike[],
	): Promise<D1Result<T>[]>;
};

export type D1PreparedStatementLike = {
	bind(...values: unknown[]): D1PreparedStatementLike;
	first<T = unknown>(columnName?: string): Promise<T | null>;
	all<T = unknown>(): Promise<D1Result<T>>;
	run<T = unknown>(): Promise<D1Result<T>>;
};

export type GeminiAccountRow = {
	id: string;
	label: string | null;
	enabled: number;
	cookie_header: string;
	cookie_hash: string;
	identity_hash: string;
	issue: GeminiAccountIssue | null;
	cooldown_until_ms: number | null;
	last_issue_at_ms: number | null;
	last_used_at_ms: number | null;
	last_refresh_at_ms: number | null;
	account_status_code: number | null;
	status_checked_at_ms: number | null;
	last_refresh_attempt_at_ms: number | null;
	last_refresh_success_at_ms: number | null;
	created_at_ms: number;
	updated_at_ms: number;
};

export type GeminiAccountSecretRow = Pick<
	GeminiAccountRow,
	| "id"
	| "cookie_header"
	| "cookie_hash"
	| "identity_hash"
	| "last_refresh_success_at_ms"
>;

export type GeminiAccountSummary = {
	id: string;
	label: string | null;
	enabled: boolean;
	state: GeminiAccountState;
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

export type GeminiAccountAdminFilter = {
	limit: number;
	cursor?: string;
	q?: string;
	state?: GeminiAccountState;
};

export type GeminiAccountSummaryPage = {
	items: GeminiAccountSummary[];
	nextCursor: string | null;
	limit: number;
};

export type GeminiAccountAdminStats = {
	total: number;
	available: number;
	cooling: number;
	attention: number;
	disabled: number;
};

export type GeminiAccountAdminOverview = GeminiAccountSummaryPage & {
	stats: GeminiAccountAdminStats;
};

export type GeminiAccountBulkAction =
	| "enable"
	| "disable"
	| "delete"
	| "refresh";

export type GeminiAccountCreateInput = {
	id?: string;
	label?: string;
	cookieHeader: string;
	identityHash?: string;
	nowMs: number;
};

export type GeminiAccountBulkCreateEntry = {
	cookieHash: string;
	input: GeminiAccountCreateInput & {
		identityHash: string;
	};
};

export type GeminiAccountBulkCreateResult = {
	createdAccountIds: ReadonlySet<string>;
	changedCredentialCount: number;
};

export type GeminiAccountIdentityImportResult = {
	item: GeminiAccountSummary;
	outcome: "created" | "credentials_changed" | "unchanged";
};

export type GeminiAccountUpdate = {
	label?: string | null;
	enabled?: boolean;
	nowMs: number;
};

export type GeminiAccountUpdateResult = {
	item: GeminiAccountSummary | null;
	changed: boolean;
};

type GeminiModelRoutingRoute = GeminiRouteTuple & {
	label: GeminiKnownTierLabel | null;
	available: boolean;
	configured: boolean;
	accountCount: number;
};

type GeminiModelRoutingFamily = {
	family: GeminiPublicFamily;
	publicNames: readonly [string, string];
	configured: boolean;
	routes: readonly GeminiModelRoutingRoute[];
};

export type GeminiModelRoutingOverview = {
	version: string;
	families: readonly GeminiModelRoutingFamily[];
};

export type GeminiAccountMutationError = {
	id?: string;
	code: string;
	message: string;
};

export type GeminiAccountMutationResult = {
	processed: number;
	changed: number;
	unchanged: number;
	failed: number;
	errors?: GeminiAccountMutationError[];
};

/** Probe payload stored by writeAccountProbe; full verifier lives in probe.ts. */
export type GeminiAccountProbe = {
	statusCode: number;
	issue: import("./domain").GeminiAccountIssue | null;
	models: readonly {
		modelId: string;
		displayName: string;
		description: string;
		available: boolean;
		capacity: number;
		capacityField: number;
		modelNumber: number;
		discoveryOrder: number;
	}[];
};

export type GeminiAccountSnapshotRow = Pick<
	GeminiAccountRow,
	| "id"
	| "enabled"
	| "cookie_header"
	| "cookie_hash"
	| "issue"
	| "cooldown_until_ms"
	| "last_used_at_ms"
	| "last_refresh_success_at_ms"
>;

export type GeminiRefreshedCookieWrite = {
	cookieHeader: string;
	refreshedAtMs: number;
	nowMs: number;
};

export type GeminiRefreshedCookieWriteResult = {
	changed: boolean;
	reason?: "duplicate_cookie";
};

export type GeminiAccountStore = {
	getPoolVersion(): Promise<string>;
	listSelectableAccounts(
		nowMs: number,
		limit: number,
	): Promise<GeminiAccountSnapshotRow[]>;
	getAccountForRefresh(
		accountId: string,
	): Promise<GeminiAccountSecretRow | null>;
	tryAcquireRefreshLock(
		accountId: string,
		owner: string,
		expiresAtMs: number,
		nowMs: number,
	): Promise<boolean>;
	releaseRefreshLock(accountId: string, owner: string): Promise<void>;
	writeRefreshedCookie(
		accountId: string,
		update: GeminiRefreshedCookieWrite,
	): Promise<GeminiRefreshedCookieWriteResult>;
	writeAccountOutcome(
		accountId: string,
		outcome: GeminiAccountOutcome,
	): Promise<void>;
	writeAccountProbe(
		accountId: string,
		probe: GeminiAccountProbe,
		checkedAtMs: number,
	): Promise<void>;
	listAccountCapabilities(
		accountIds: readonly string[],
	): Promise<GeminiAccountCapabilityRow[]>;
	listAllAccountCapabilities(
		limit: number,
	): Promise<GeminiAccountCapabilityRow[]>;
	listModelRoutePriorities(): Promise<GeminiModelRoutePriorityRow[]>;
	replaceModelRoutePriority(
		family: GeminiPublicFamily,
		routes: readonly GeminiRouteTuple[],
		nowMs: number,
	): Promise<void>;
	clearModelRoutePriority(
		family: GeminiPublicFamily,
		nowMs: number,
	): Promise<void>;
	getAdminOverview(
		filter: GeminiAccountAdminFilter,
		nowMs: number,
	): Promise<GeminiAccountAdminOverview>;
	findAccountByCookieHash(
		cookieHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null>;
	findAccountByIdentityHash(
		identityHash: string,
		nowMs: number,
	): Promise<GeminiAccountSummary | null>;
	createAccount(input: GeminiAccountCreateInput): Promise<GeminiAccountSummary>;
	importAccountByIdentity(
		entry: GeminiAccountBulkCreateEntry,
	): Promise<GeminiAccountIdentityImportResult>;
	createAccountsBulk(
		entries: GeminiAccountBulkCreateEntry[],
	): Promise<GeminiAccountBulkCreateResult>;
	updateAccount(
		accountId: string,
		update: GeminiAccountUpdate,
	): Promise<GeminiAccountUpdateResult>;
	deleteAccount(accountId: string, nowMs: number): Promise<boolean>;
	setAccountsEnabledBulk(
		accountIds: readonly string[],
		enabled: boolean,
		nowMs: number,
	): Promise<string[]>;
	deleteAccountsBulk(
		accountIds: readonly string[],
		nowMs: number,
	): Promise<string[]>;
};

export type GeminiAccountRouteRequirement = {
	candidates: readonly GeminiRouteTuple[];
	fallbackRoute: GeminiRouteTuple | null;
};

export type GeminiAccountAcquireOptions = {
	excludeAccountIds?: ReadonlySet<string> | readonly string[];
	routeRequirement?: GeminiAccountRouteRequirement;
	capabilityMode?: "off" | "prefer" | "strict";
	capabilityFreshAfterMs?: number;
};
