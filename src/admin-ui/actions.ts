import {
	AdminApiError,
	checkBrowserNow,
	clearBrowserCredentials,
	configureBrowserCredentials,
	createAccount,
	createAccountsWithLimitFallback,
	deleteAccountBrowserProfile,
	getAccountOverview,
	openAccountBrowser,
	runAccountAction,
	stopAccountBrowser,
	updateAccount,
} from "./api";
import { localActionLabel, tr } from "./i18n";
import {
	accountDisplayName,
	identifier,
	identifierKey,
	parseBatchImport,
	resultSummary,
	text,
	validateCookieValue,
} from "./logic";
import { loadModelRoutingForSession } from "./model-routing-actions";
import {
	type AdminSession,
	beginAccountLoad,
	confirmBrowserDestructiveAction,
	confirmDeletion,
	currentAccountLoadGeneration,
	currentAdminSession,
	currentVerifiedAdminSession,
	invalidateAdminSession,
	isCurrentAccountLoad,
	isCurrentAdminSession,
	runAdminSessionOperation,
	showToast,
} from "./session";
import {
	accountStats,
	accounts,
	authExpanded,
	batchBusy,
	browserCredentialsDraft,
	claimAccountOperation,
	connectionVerified,
	cursorStack,
	editBusy,
	editDraft,
	importBatch,
	importBusy,
	importLabel,
	importPsid,
	importPsidts,
	loading,
	nextCursor,
	pageIndex,
	query,
	releaseAccountOperation,
	rowBusy,
	selected,
	stateFilter,
} from "./state";
import type {
	AccountAction,
	AccountIdentifier,
	BrowserAdminStatus,
	BrowserCredentialsInput,
	GeminiAccount,
} from "./types";

export {
	moveModelRoute,
	resetModelRoutePriorityAction,
	saveModelRoutePriority,
} from "./model-routing-actions";

export function selectedIdentifiers(): AccountIdentifier[] {
	if (loading.value) return [];
	const current = selected.value;
	return accounts.value
		.filter((account) => current.has(identifierKey(account)))
		.map(identifier);
}

export async function loadAccounts(
	direction: "current" | "reset" | "next" | "prev" = "current",
	verifyConnection = false,
): Promise<void> {
	if (verifyConnection) invalidateAdminSession();
	const session = currentAdminSession();
	if (!session.adminKey) {
		showToast(tr("Admin key is required"), "error");
		return;
	}
	if (!verifyConnection && !connectionVerified.value) return;
	const page = requestedAccountPage(direction);
	if (!page) return;
	const generation = beginAccountLoad();
	const requestedQuery = query.value.trim();
	const requestedState = stateFilter.value;
	loading.value = true;
	try {
		const result = await runAdminSessionOperation(
			session,
			() =>
				getAccountOverview(session, {
					cursor: page.cursor,
					q: requestedQuery,
					state: requestedState,
				}),
			{
				fallbackMessage: tr("Failed to load accounts"),
				isCurrent: () => isCurrentAccountLoad(session, generation),
				invalidateOnError: verifyConnection,
			},
		);
		if (!result.ok) return;
		const overview = result.value;
		commitAccountPage(page, overview);
		if (verifyConnection) {
			connectionVerified.value = true;
			authExpanded.value = false;
			await loadModelRoutingForSession(session);
		}
		if (!isCurrentAccountLoad(session, generation)) return;
		showToast(tr("Loaded account count", { count: overview.items.length }));
	} finally {
		if (isCurrentAccountLoad(session, generation)) loading.value = false;
	}
}

type RequestedAccountPage = {
	cursor: string;
	cursorStack: string[];
	pageIndex: number;
	resetSelection: boolean;
};

type AccountOverviewResult = Awaited<ReturnType<typeof getAccountOverview>>;

function commitAccountPage(
	page: RequestedAccountPage,
	overview: AccountOverviewResult,
): void {
	cursorStack.value = page.cursorStack;
	pageIndex.value = page.pageIndex;
	accounts.value = overview.items;
	accountStats.value = overview.stats;
	nextCursor.value = overview.nextCursor;
	const currentSelection = page.resetSelection ? [] : [...selected.value];
	selected.value = new Set(
		currentSelection.filter((key) =>
			overview.items.some((account) => identifierKey(account) === key),
		),
	);
}

function requestedAccountPage(
	direction: "current" | "reset" | "next" | "prev",
): RequestedAccountPage | null {
	let nextStack = [...cursorStack.value];
	let nextPageIndex = pageIndex.value;
	if (direction === "reset") {
		nextStack = [""];
		nextPageIndex = 0;
	} else if (direction === "next") {
		if (!nextCursor.value) return null;
		nextPageIndex += 1;
		nextStack[nextPageIndex] = nextCursor.value;
	} else if (direction === "prev") {
		if (nextPageIndex <= 0) return null;
		nextPageIndex -= 1;
	}
	return {
		cursor: nextStack[nextPageIndex] || "",
		cursorStack: nextStack,
		pageIndex: nextPageIndex,
		resetSelection: direction === "reset",
	};
}

export async function submitImport(event: Event): Promise<void> {
	event.preventDefault();
	const session = currentVerifiedAdminSession();
	if (!session) return;
	try {
		importBusy.value = true;
		const operation = await runAdminSessionOperation(
			session,
			async () => {
				const batch = parseBatchImport(importBatch.value);
				return batch.length
					? createAccountsWithLimitFallback(session, { accounts: batch })
					: createAccount(session, {
							label: importLabel.value.trim(),
							psid: validateCookieValue(importPsid.value, "__Secure-1PSID"),
							psidts: validateCookieValue(
								importPsidts.value,
								"__Secure-1PSIDTS",
							),
						});
			},
			{ fallbackMessage: tr("Import failed") },
		);
		if (!operation.ok) return;
		const result = operation.value;
		showToast(
			resultSummary("import", result),
			result.failed ? "error" : undefined,
		);
		resetImport();
		await loadAccounts("reset");
	} finally {
		if (isCurrentAdminSession(session)) importBusy.value = false;
	}
}

type RunActionOptions = { targetLabel?: string; scope?: "batch" | "row" };

export async function runAction(
	action: AccountAction,
	identifiers: AccountIdentifier[],
	options: RunActionOptions = {},
): Promise<void> {
	if (loading.value) return;
	if (!identifiers.length) {
		showToast(tr("Select at least one account"), "error");
		return;
	}
	const targetLabel = options.targetLabel || tr("selected account(s)");
	if (action === "delete") {
		const confirmed = await confirmDeletion(identifiers.length, targetLabel);
		if (!confirmed) return;
	}
	if (loading.value) return;
	const session = currentVerifiedAdminSession();
	if (!session) return;
	const keys = identifiers.map((item) => item.id);
	const loadGeneration = currentAccountLoadGeneration();
	if (!isCurrentAccountLoad(session, loadGeneration)) return;
	const claim = claimAccountOperation(keys);
	if (!claim) {
		showToast(tr("Account operation already in progress"), "error");
		return;
	}
	const rowScoped = options.scope === "row" && keys.length === 1;
	try {
		if (rowScoped)
			rowBusy.value = { ...rowBusy.value, [keys[0] || ""]: action };
		else batchBusy.value = action;
		const operation = await runAdminSessionOperation(
			session,
			() => runAccountAction(session, action, identifiers),
			{
				isCurrent: () => isCurrentAccountLoad(session, loadGeneration),
				fallbackMessage: tr("Action failure", {
					action: localActionLabel(action, true),
				}),
			},
		);
		if (!operation.ok) return;
		const result = operation.value;
		if (isCurrentAccountLoad(session, loadGeneration)) {
			showToast(
				resultSummary(action, result),
				result.failed ? "error" : undefined,
			);
			await loadAccounts();
		}
	} finally {
		releaseAccountOperation(claim);
		if (isCurrentAdminSession(session)) {
			if (rowScoped) {
				const next = { ...rowBusy.value };
				delete next[keys[0] || ""];
				rowBusy.value = next;
			} else batchBusy.value = "";
		}
	}
}

export async function submitEdit(event: Event): Promise<void> {
	event.preventDefault();
	if (loading.value) return;
	const session = currentVerifiedAdminSession();
	if (!session) return;
	const draft = editDraft.value;
	if (!draft) return;
	const account = accounts.value.find(
		(item) => identifierKey(item) === draft.key,
	);
	if (!account) {
		editDraft.value = null;
		return;
	}
	const loadGeneration = currentAccountLoadGeneration();
	if (!isCurrentAccountLoad(session, loadGeneration)) return;
	const claim = claimAccountOperation([account.id]);
	if (!claim) {
		showToast(tr("Account operation already in progress"), "error");
		return;
	}
	try {
		editBusy.value = true;
		const operation = await runAdminSessionOperation(
			session,
			() =>
				updateAccount(session, {
					...identifier(account),
					label: draft.label.trim() || null,
				}),
			{
				isCurrent: () => isCurrentAccountLoad(session, loadGeneration),
				fallbackMessage: tr("Update failed"),
			},
		);
		if (!operation.ok) return;
		const result = operation.value;
		if (isCurrentAccountLoad(session, loadGeneration)) {
			showToast(
				resultSummary("update", result),
				result.failed ? "error" : undefined,
			);
			editDraft.value = null;
			await loadAccounts();
		}
	} finally {
		releaseAccountOperation(claim);
		if (isCurrentAdminSession(session)) editBusy.value = false;
	}
}

export function openBrowserCredentials(account: GeminiAccount): void {
	browserCredentialsDraft.value = {
		accountId: account.id,
		accountLabel: accountDisplayName(account),
		credentialsConfigured: account.browser.credentialsConfigured,
	};
}

export async function configureBrowserLogin(
	accountId: string,
	credentials: BrowserCredentialsInput,
): Promise<boolean> {
	return runBrowserStatusAction(
		accountId,
		"browser_credentials",
		(session) => configureBrowserCredentials(session, accountId, credentials),
		tr("Browser credentials saved"),
		tr("Failed to save browser credentials"),
	);
}

export async function clearBrowserLogin(account: GeminiAccount): Promise<void> {
	if (
		!(await confirmBrowserDestructiveAction(
			"clear_browser_credentials",
			account.id,
			accountDisplayName(account),
		))
	)
		return;
	await runBrowserStatusAction(
		account.id,
		"browser_credentials",
		(session) => clearBrowserCredentials(session, account.id),
		tr("Browser credentials cleared"),
		tr("Failed to clear browser credentials"),
	);
}

export async function checkBrowserForAccount(
	account: GeminiAccount,
): Promise<void> {
	await runBrowserStatusAction(
		account.id,
		"browser_check",
		(session) => checkBrowserNow(session, account.id),
		tr("Browser check queued"),
		tr("Failed to queue browser check"),
	);
}

export async function deleteBrowserProfile(
	account: GeminiAccount,
): Promise<void> {
	if (
		!(await confirmBrowserDestructiveAction(
			"delete_browser_profile",
			account.id,
			accountDisplayName(account),
		))
	)
		return;
	await runBrowserVoidAction(
		account.id,
		"browser_profile",
		(session) => deleteAccountBrowserProfile(session, account.id),
		tr("Browser profile deleted"),
		tr("Failed to delete browser profile"),
	);
}

export async function openBrowserForAccount(
	account: GeminiAccount,
): Promise<void> {
	const popup = openWaitingPopup();
	if (!popup) {
		showToast(tr("Browser popup was blocked"), "error");
		return;
	}
	const session = currentVerifiedAdminSession();
	if (!session) {
		popup.close();
		return;
	}
	const claim = claimAccountOperation([account.id]);
	if (!claim) {
		popup.close();
		showToast(tr("Account operation already in progress"), "error");
		return;
	}
	rowBusy.value = { ...rowBusy.value, [account.id]: "browser_open" };
	try {
		const outcome = await openBrowserAttempt(session, account, popup);
		if (outcome !== "conflict") return;
		if (!window.confirm(tr("Stop visible browser confirmation"))) {
			popup.close();
			return;
		}
		const stopped = await runAdminSessionOperation(
			session,
			() => stopAccountBrowser(session),
			{ fallbackMessage: tr("Failed to stop visible browser") },
		);
		if (!stopped.ok) {
			popup.close();
			return;
		}
		const retried = await openBrowserAttempt(session, account, popup);
		if (retried === "conflict") {
			popup.close();
			showToast(tr("Failed to open browser"), "error");
		}
	} finally {
		releaseAccountOperation(claim);
		if (isCurrentAdminSession(session)) clearRowBusy(account.id);
	}
}

async function openBrowserAttempt(
	session: AdminSession,
	account: GeminiAccount,
	popup: Window,
): Promise<"done" | "conflict"> {
	try {
		const opened = await openAccountBrowser(session, account.id);
		if (!isCurrentAdminSession(session)) {
			popup.close();
			return "done";
		}
		popup.location.href = safeNoVncUrl(opened.url);
		return "done";
	} catch (error) {
		if (
			isCurrentAdminSession(session) &&
			error instanceof AdminApiError &&
			error.status === 409 &&
			error.code === "visible_session_conflict"
		)
			return "conflict";
		popup.close();
		await runAdminSessionOperation(session, () => Promise.reject(error), {
			fallbackMessage: tr("Failed to open browser"),
		});
		return "done";
	}
}

function openWaitingPopup(): Window | null {
	const popup = window.open("about:blank", "_blank");
	if (!popup) return null;
	try {
		popup.opener = null;
		popup.document.title = tr("Opening browser");
		popup.document.body.textContent = tr("Browser waiting message");
		return popup;
	} catch {
		popup.close();
		return null;
	}
}

function safeNoVncUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("unsafe browser URL");
	}
	const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
	const isLoopback = loopback.has(url.hostname.toLowerCase());
	const sameHost =
		url.hostname.toLowerCase() === window.location.hostname.toLowerCase();
	if (
		!(["http:", "https:"] as string[]).includes(url.protocol) ||
		(!sameHost && !isLoopback) ||
		(!isLoopback && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("unsafe browser URL");
	return url.href;
}

async function runBrowserStatusAction(
	accountId: string,
	busy: string,
	request: (session: AdminSession) => Promise<BrowserAdminStatus>,
	successMessage: string,
	fallbackMessage: string,
): Promise<boolean> {
	return runBrowserOperation(
		accountId,
		busy,
		request,
		async (result) => {
			updateBrowserStatus(accountId, result);
			showToast(successMessage);
			await loadAccounts();
		},
		fallbackMessage,
	);
}

async function runBrowserVoidAction(
	accountId: string,
	busy: string,
	request: (session: AdminSession) => Promise<void>,
	successMessage: string,
	fallbackMessage: string,
): Promise<boolean> {
	return runBrowserOperation(
		accountId,
		busy,
		request,
		() => {
			showToast(successMessage);
		},
		fallbackMessage,
	);
}

async function runBrowserOperation<T>(
	accountId: string,
	busy: string,
	request: (session: AdminSession) => Promise<T>,
	onSuccess: (value: T) => void | Promise<void>,
	fallbackMessage: string,
): Promise<boolean> {
	const session = currentVerifiedAdminSession();
	if (!session) return false;
	const claim = claimAccountOperation([accountId]);
	if (!claim) {
		showToast(tr("Account operation already in progress"), "error");
		return false;
	}
	rowBusy.value = { ...rowBusy.value, [accountId]: busy };
	try {
		const operation = await runAdminSessionOperation(
			session,
			() => request(session),
			{ fallbackMessage },
		);
		if (!operation.ok) return false;
		await onSuccess(operation.value);
		return true;
	} finally {
		releaseAccountOperation(claim);
		if (isCurrentAdminSession(session)) clearRowBusy(accountId);
	}
}

function updateBrowserStatus(
	accountId: string,
	value: BrowserAdminStatus,
): void {
	accounts.value = accounts.value.map((account) =>
		account.id === accountId
			? {
					...account,
					browser: {
						credentialsConfigured: value.credentialsConfigured,
						...value.status,
					},
				}
			: account,
	);
}

function clearRowBusy(accountId: string): void {
	const next = { ...rowBusy.value };
	delete next[accountId];
	rowBusy.value = next;
}

export function openEdit(account: GeminiAccount): void {
	editDraft.value = { key: identifierKey(account), label: text(account.label) };
}

export function resetImport(): void {
	importLabel.value = "";
	importPsid.value = "";
	importPsidts.value = "";
	importBatch.value = "";
}
