import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { loadAccounts } from "./actions";
import { BrowserCredentialsModal } from "./components/BrowserCredentialsModal";
import { ConfirmationModal } from "./components/ConfirmationModal";
import { EditModal } from "./components/EditModal";
import { tr } from "./i18n";
import { AuthPanel } from "./sections/AuthPanel";
import { ImportPanel } from "./sections/ImportPanel";
import { ModelRoutingSection } from "./sections/ModelRoutingSection";
import { OverviewSection } from "./sections/OverviewSection";
import { Toasts } from "./sections/Toasts";
import { Topbar } from "./sections/Topbar";
import { Workspace } from "./sections/Workspace";
import { restoreAdminKey } from "./session";
import { adminKey, browserCredentialsDraft, connectionVerified } from "./state";

export function App(): JSX.Element {
	useEffect(() => {
		restoreAdminKey();
		if (adminKey.value) void loadAccounts("reset", true);
	}, []);
	const connected = connectionVerified.value;
	const credentialsDraft = browserCredentialsDraft.value;

	return (
		<>
			{connected ? (
				<a class="skip-link" href="#accounts-workspace">
					{tr("Skip to accounts")}
				</a>
			) : null}
			<Topbar />
			<main class="shell">
				<AuthPanel />
				{connected ? (
					<>
						<OverviewSection />
						<ModelRoutingSection />
						<ImportPanel />
						<Workspace />
					</>
				) : null}
			</main>
			<EditModal />
			{credentialsDraft ? (
				<BrowserCredentialsModal key={credentialsDraft.accountId} />
			) : null}
			<ConfirmationModal />
			<Toasts />
		</>
	);
}
