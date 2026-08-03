export class BrowserHelperClientError extends Error {
	readonly status: number;
	readonly code: string;
}

export type BrowserHelperClient = {
	checkNow(accountId: string): Promise<void>;
	openVisible(
		accountId: string,
		signal?: AbortSignal,
	): Promise<{ url: string }>;
	stopVisible(): Promise<void>;
	deleteProfile(accountId: string): Promise<void>;
};

export function createBrowserHelperClient(
	sourceEnv?: Record<string, string | undefined>,
	options?: {
		fetch?: typeof fetch;
		timeoutMs?: number;
		openTimeoutMs?: number;
		timeoutSignal?: (milliseconds: number) => AbortSignal;
	},
): BrowserHelperClient | null;
