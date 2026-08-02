import { useComputed } from "@preact/signals";
import type { JSX } from "preact";
import {
	checkBrowserForAccount,
	clearBrowserLogin,
	deleteBrowserProfile,
	openBrowserCredentials,
	openBrowserForAccount,
	openEdit,
	runAction,
} from "../actions";
import { tr } from "../i18n";
import { Icon } from "../icons";
import {
	accountBusyLabel,
	accountDisplayName,
	identifier,
	identifierKey,
	relativeTime,
} from "../logic";
import { rowBusy } from "../state";
import type { AccountAction, GeminiAccount } from "../types";

export function BrowserAccountSummary({
	account,
}: {
	account: GeminiAccount;
}): JSX.Element {
	return (
		<div class="browser-summary">
			<div class="browser-summary-badges">
				<span
					class={`badge ${
						account.browser.credentialsConfigured
							? "browser-configured"
							: "browser-unconfigured"
					}`}
				>
					{tr(
						account.browser.credentialsConfigured
							? "Configured"
							: "Not configured",
					)}
				</span>
				<span class={`badge browser-state-${account.browser.state}`}>
					{tr(account.browser.state)}
				</span>
			</div>
			<span class="row-sub">
				{tr("Last browser check")}:{" "}
				{relativeTime(account.browser.lastCheckAtMs)}
			</span>
		</div>
	);
}

export function AccountActions({
	account,
}: {
	account: GeminiAccount;
}): JSX.Element {
	const key = identifierKey(account);
	const busy = useComputed(() => rowBusy.value[key] || "").value;
	const label = accountDisplayName(account);
	const actionAriaLabel = (action: string): string =>
		tr("Account action label", { action, label });
	const run = (action: AccountAction): void => {
		void runAction(action, [identifier(account)], {
			scope: "row",
			targetLabel: tr("Account target", { label }),
		});
	};
	return (
		<div class="account-actions">
			<button
				type="button"
				disabled={!!busy}
				aria-label={tr("Refresh account", { label })}
				onClick={() => run("refresh")}
			>
				<Icon name="refresh" />
				{busy === "refresh" ? `${tr("Refreshing")}…` : tr("Refresh")}
			</button>
			<details class="action-menu">
				<summary aria-label={tr("More account actions", { label })}>
					{tr("More")}
				</summary>
				<div class="action-menu-items">
					<button
						type="button"
						disabled={!!busy}
						aria-label={actionAriaLabel(tr("Configure login"))}
						onClick={() => openBrowserCredentials(account)}
					>
						{tr("Configure login")}
					</button>
					<button
						type="button"
						disabled={!!busy || !account.browser.credentialsConfigured}
						aria-label={actionAriaLabel(tr("Clear credentials"))}
						onClick={() => void clearBrowserLogin(account)}
					>
						{tr("Clear credentials")}
					</button>
					<button
						type="button"
						disabled={!!busy || !account.enabled}
						aria-label={actionAriaLabel(tr("Check now"))}
						onClick={() => void checkBrowserForAccount(account)}
					>
						{tr("Check now")}
					</button>
					<button
						type="button"
						disabled={!!busy || !account.enabled}
						aria-label={actionAriaLabel(tr("Open browser"))}
						onClick={() => void openBrowserForAccount(account)}
					>
						{tr("Open browser")}
					</button>
					<button
						type="button"
						disabled={!!busy}
						class="danger"
						aria-label={actionAriaLabel(tr("Delete browser profile"))}
						onClick={() => void deleteBrowserProfile(account)}
					>
						{tr("Delete browser profile")}
					</button>
					<button
						type="button"
						disabled={!!busy}
						aria-label={actionAriaLabel(tr("Rename"))}
						onClick={() => openEdit(account)}
					>
						<Icon name="edit" />
						{tr("Rename")}
					</button>
					<button
						type="button"
						disabled={!!busy}
						aria-label={actionAriaLabel(
							tr(account.enabled ? "Disable" : "Enable"),
						)}
						onClick={() => run(account.enabled ? "disable" : "enable")}
					>
						{tr(account.enabled ? "Disable" : "Enable")}
					</button>
					<button
						type="button"
						disabled={!!busy}
						class="danger"
						aria-label={actionAriaLabel(tr("Delete"))}
						onClick={() => run("delete")}
					>
						<Icon name="trash" />
						{tr("Delete")}
					</button>
				</div>
			</details>
			{busy ? (
				<span class="row-busy" role="status">
					{accountBusyLabel(busy)}
				</span>
			) : null}
		</div>
	);
}
