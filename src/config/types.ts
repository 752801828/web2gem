import type { BrowserCredentialCrypto } from "../browser/types";
import type { BrowserAccountStore } from "../browser/types";
import type {
	CandidateCookieInput,
	CandidateCookieResult,
} from "../browser/candidate-cookie";

export type AppEnv = Record<string, unknown> & {
	BROWSER_CREDENTIAL_CRYPTO?: BrowserCredentialCrypto;
	BROWSER_HELPER_INTERNAL_TOKEN?: string;
	BROWSER_ACCOUNT_STORE?: BrowserAccountStore;
	BROWSER_CANDIDATE_COOKIE_SERVICE?: {
		replace(input: CandidateCookieInput): Promise<CandidateCookieResult>;
	};
	BROWSER_HELPER_CLIENT?: {
		checkNow(accountId: string): Promise<void>;
		openVisible(
			accountId: string,
			signal?: AbortSignal,
		): Promise<{ url: string }>;
		stopVisible(): Promise<void>;
		deleteProfile(accountId: string): Promise<void>;
	};
};

export type GeminiAccountLeaseContext = {
	accountId: string;
	cookieHash: string;
	observeSetCookie?: (values: readonly string[]) => void;
};

export type StaticRuntimeConfig = Readonly<{
	gemini_bl: string;
	gemini_origin: string;
	default_model: string;
	retry_attempts: number;
	gemini_account_max_attempts: number;
	gemini_account_refresh_interval_sec: number;
	gemini_account_capability_ttl_sec: number;
	gemini_account_capability_mode: "off" | "prefer" | "strict";
	retry_delay_sec: number;
	request_timeout_sec: number;
	request_body_max_bytes: number;
	log_requests: boolean;
	current_input_file_enabled: boolean;
	current_input_file_min_bytes: number;
	generic_file_upload_max_bytes: number;
	api_keys: readonly string[];
	admin_key: string;
}>;

export type RuntimeExecutionContext = {
	supports_authenticated_session?: boolean;
	execution_ctx?: { waitUntil(promise: Promise<unknown>): void };
};

export type GeminiAccountSessionContext = {
	cookie: string;
	sapisid: string;
	gemini_account?: GeminiAccountLeaseContext;
};

export type RuntimeConfig = StaticRuntimeConfig &
	RuntimeExecutionContext &
	GeminiAccountSessionContext;
