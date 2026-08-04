import { computed, signal } from "@preact/signals";
import type {
	AccountStats,
	GeminiAccount,
	GeminiAccountState,
	ModelFamily,
	ModelRoutingDraft,
	ModelRoutingOverview,
} from "./types";

export const KEY_STORAGE = "web2gem_gemini_admin_key";
export const KEY_STORAGE_MODE = "web2gem_gemini_admin_key_storage";

export const accountStates = [
	"available",
	"cooling",
	"attention",
	"disabled",
] as const satisfies readonly GeminiAccountState[];

type ToastItem = { id: number; message: string; kind?: "error" };
type ConfirmationDraft =
	| {
			action: "delete";
			count: number;
			targetLabel: string;
	  }
	| {
			action: "clear_browser_credentials" | "delete_browser_profile";
			accountId: string;
			accountLabel: string;
	  };
type EditDraft = { key: string; label: string };
type BrowserCredentialsDraft = {
	accountId: string;
	accountLabel: string;
	credentialsConfigured: boolean;
};
export type AccountCookieDraft = {
	accountId: string;
	accountLabel: string;
};

export function emptyModelRoutingDrafts(): Record<
	ModelFamily,
	ModelRoutingDraft
> {
	return {
		pro: { routes: [], busy: false, error: null, dirty: false },
		flash: { routes: [], busy: false, error: null, dirty: false },
		flash_lite: { routes: [], busy: false, error: null, dirty: false },
	};
}

type ProtectedAdminState = {
	connectionVerified: boolean;
	accounts: GeminiAccount[];
	selected: Set<string>;
	cursorStack: string[];
	pageIndex: number;
	nextCursor: string | null;
	accountStats: AccountStats | null;
	loading: boolean;
	editDraft: EditDraft | null;
	browserCredentialsDraft: BrowserCredentialsDraft | null;
	accountCookieDraft: AccountCookieDraft | null;
	importBusy: boolean;
	editBusy: boolean;
	batchBusy: string;
	rowBusy: Record<string, string>;
	operationBusyKeys: Map<string, string>;
	confirmationDraft: ConfirmationDraft | null;
	authExpanded: boolean;
	modelRouting: ModelRoutingOverview | null;
	modelRoutingLoading: boolean;
	modelRoutingDrafts: Record<ModelFamily, ModelRoutingDraft>;
};

export function createProtectedAdminState(): ProtectedAdminState {
	return {
		connectionVerified: false,
		accounts: [],
		selected: new Set(),
		cursorStack: [""],
		pageIndex: 0,
		nextCursor: null,
		accountStats: null,
		loading: false,
		editDraft: null,
		browserCredentialsDraft: null,
		accountCookieDraft: null,
		importBusy: false,
		editBusy: false,
		batchBusy: "",
		rowBusy: {},
		operationBusyKeys: new Map(),
		confirmationDraft: null,
		authExpanded: true,
		modelRouting: null,
		modelRoutingLoading: false,
		modelRoutingDrafts: emptyModelRoutingDrafts(),
	};
}

const initialProtectedState = createProtectedAdminState();

export const adminKey = signal("");
export const connectionVerified = signal(
	initialProtectedState.connectionVerified,
);
export const accounts = signal(initialProtectedState.accounts);
export const selected = signal(initialProtectedState.selected);
export const loading = signal(initialProtectedState.loading);
export const query = signal("");
export const stateFilter = signal<GeminiAccountState | "">("");
export const cursorStack = signal(initialProtectedState.cursorStack);
export const pageIndex = signal(initialProtectedState.pageIndex);
export const nextCursor = signal(initialProtectedState.nextCursor);
export const toastItems = signal<ToastItem[]>([]);
export const editDraft = signal(initialProtectedState.editDraft);
export const browserCredentialsDraft = signal(
	initialProtectedState.browserCredentialsDraft,
);
export const accountCookieDraft = signal(
	initialProtectedState.accountCookieDraft,
);
export const importLabel = signal("");
export const importPsid = signal("");
export const importPsidts = signal("");
export const importBatch = signal("");
export const keyStorageMode = signal<"session" | "local">("session");
export const accountStats = signal(initialProtectedState.accountStats);
export const importBusy = signal(initialProtectedState.importBusy);
export const editBusy = signal(initialProtectedState.editBusy);
export const batchBusy = signal(initialProtectedState.batchBusy);
export const rowBusy = signal(initialProtectedState.rowBusy);
export const operationBusyKeys = signal(
	initialProtectedState.operationBusyKeys,
);
export const confirmationDraft = signal(
	initialProtectedState.confirmationDraft,
);
export const importExpanded = signal(false);
export const authExpanded = signal(initialProtectedState.authExpanded);
export const modelRouting = signal(initialProtectedState.modelRouting);
export const modelRoutingLoading = signal(
	initialProtectedState.modelRoutingLoading,
);
export const modelRoutingDrafts = signal(
	initialProtectedState.modelRoutingDrafts,
);

export type AccountOperationClaim = {
	owner: string;
	keys: readonly string[];
};

let accountOperationOwner = 0;

export function claimAccountOperation(
	keys: readonly string[],
): AccountOperationClaim | null {
	const uniqueKeys = [...new Set(keys.filter(Boolean))];
	if (uniqueKeys.some((key) => operationBusyKeys.value.has(key))) return null;
	const owner = `account-operation-${++accountOperationOwner}`;
	operationBusyKeys.value = new Map([
		...operationBusyKeys.value,
		...uniqueKeys.map((key) => [key, owner] as const),
	]);
	return { owner, keys: uniqueKeys };
}

export function releaseAccountOperation(claim: AccountOperationClaim): void {
	const next = new Map(operationBusyKeys.value);
	for (const key of claim.keys) {
		if (next.get(key) === claim.owner) next.delete(key);
	}
	operationBusyKeys.value = next;
}

export const metricSummary = computed(() => {
	const stats = accountStats.value;
	const rows = accounts.value;
	return {
		total: stats?.total ?? rows.length,
		available:
			stats?.available ??
			rows.filter((item) => item.state === "available").length,
		cooling:
			stats?.cooling ?? rows.filter((item) => item.state === "cooling").length,
		attention:
			stats?.attention ??
			rows.filter((item) => item.state === "attention").length,
		disabled:
			stats?.disabled ??
			rows.filter((item) => item.state === "disabled").length,
	};
});

export const hasFilters = computed(() =>
	Boolean(query.value.trim() || stateFilter.value),
);
