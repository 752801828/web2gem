export type BrowserCredentials = {
	email: string;
	password: string;
	totpSecret: string;
};

export type EncryptedBrowserCredentials = {
	version: 1;
	ciphertext: string;
	nonce: string;
	emailHash: string;
};

export type BrowserCredentialCrypto = {
	encrypt(
		accountId: string,
		credentials: BrowserCredentials,
	): Promise<EncryptedBrowserCredentials>;
	decrypt(
		accountId: string,
		encrypted: EncryptedBrowserCredentials,
	): Promise<BrowserCredentials>;
};

export const BROWSER_STATES = [
	"idle",
	"checking",
	"ready",
	"login_required",
	"manual_action_required",
	"error",
] as const;

export type BrowserState = (typeof BROWSER_STATES)[number];

export function browserState(value: unknown): BrowserState {
	return typeof value === "string" &&
		(BROWSER_STATES as readonly string[]).includes(value)
		? (value as BrowserState)
		: "idle";
}

export type BrowserAccountStatus = {
	credentialsConfigured: boolean;
	state: BrowserState;
	lastCheckAtMs: number | null;
	lastCookieUpdateAtMs: number | null;
	lastAutoLoginAtMs: number | null;
	failureCode: string | null;
};

export type BrowserScheduleAccount = {
	accountId: string;
	label: string | null;
	status: BrowserAccountStatus;
	authFailureCount: number;
	autoLoginAttemptDate: string | null;
	autoLoginAttemptCount: number;
};

export type BrowserStatusUpdate = {
	state: BrowserState;
	lastCheckAtMs: number | null;
	lastCookieUpdateAtMs: number | null;
	lastAutoLoginAtMs: number | null;
	authFailureCount: number;
	notificationState: string | null;
	failureCode: string | null;
	nowMs: number;
};

export interface BrowserAccountStore {
	listScheduled(nowMs: number): Promise<BrowserScheduleAccount[]>;
	getStatus(accountId: string): Promise<BrowserAccountStatus | null>;
	putCredentials(
		accountId: string,
		value: EncryptedBrowserCredentials,
		nowMs: number,
	): Promise<void>;
	clearCredentials(accountId: string, nowMs: number): Promise<void>;
	getEncryptedCredentials(
		accountId: string,
	): Promise<EncryptedBrowserCredentials | null>;
	tryAcquireLease(
		accountId: string,
		owner: string,
		expiresAtMs: number,
		nowMs: number,
	): Promise<boolean>;
	releaseLease(accountId: string, owner: string): Promise<void>;
	writeStatus(accountId: string, update: BrowserStatusUpdate): Promise<void>;
	recordAutoLoginAttempt(
		accountId: string,
		date: string,
		nowMs: number,
	): Promise<number>;
}
