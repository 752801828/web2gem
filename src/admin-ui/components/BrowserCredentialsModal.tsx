import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { configureBrowserLogin } from "../actions";
import { tr } from "../i18n";
import { browserCredentialsDraft } from "../state";
import { DialogSurface } from "./DialogSurface";

export function BrowserCredentialsModal(): JSX.Element | null {
	const draft = browserCredentialsDraft.value;
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [totpSecret, setTotpSecret] = useState("");
	const [busy, setBusy] = useState(false);
	if (!draft) return null;

	const clear = (): void => {
		setEmail("");
		setPassword("");
		setTotpSecret("");
	};
	const close = (): void => {
		if (busy) return;
		clear();
		browserCredentialsDraft.value = null;
	};
	const submit = async (event: Event): Promise<void> => {
		event.preventDefault();
		setBusy(true);
		let saved = false;
		try {
			saved = await configureBrowserLogin(draft.accountId, {
				email,
				password,
				totpSecret,
			});
		} finally {
			clear();
			setBusy(false);
			if (saved) browserCredentialsDraft.value = null;
		}
	};

	return (
		<DialogSurface
			labelledBy="browser-credentials-title"
			describedBy="browser-credentials-help"
			onClose={close}
		>
			<div class="dialog-head">
				<div>
					<div id="browser-credentials-title" class="dialog-title">
						{tr("Browser login")}
					</div>
					<div class="help">{draft.accountLabel}</div>
				</div>
				<button type="button" disabled={busy} onClick={close}>
					{tr("Close")}
				</button>
			</div>
			<p id="browser-credentials-help" class="dialog-copy">
				{tr("Browser credential help")}
			</p>
			<form
				class="grid browser-credentials-form"
				aria-busy={busy}
				onSubmit={(event) => void submit(event)}
			>
				<label>
					{tr("Email")}
					<input
						data-dialog-initial
						type="email"
						autoComplete="username"
						required={!draft.credentialsConfigured}
						value={email}
						onInput={(event) =>
							setEmail((event.currentTarget as HTMLInputElement).value)
						}
					/>
				</label>
				<label>
					{tr("Password")}
					<input
						type="password"
						autoComplete="current-password"
						required={!draft.credentialsConfigured}
						value={password}
						onInput={(event) =>
							setPassword((event.currentTarget as HTMLInputElement).value)
						}
					/>
				</label>
				<label>
					{tr("Authenticator seed")}
					<input
						type="password"
						autoComplete="one-time-code"
						required={!draft.credentialsConfigured}
						value={totpSecret}
						onInput={(event) =>
							setTotpSecret((event.currentTarget as HTMLInputElement).value)
						}
					/>
					<span class="field-note">{tr("Authenticator seed help")}</span>
				</label>
				{draft.credentialsConfigured ? (
					<p class="field-note">{tr("Leave configured fields blank")}</p>
				) : null}
				<div class="actions dialog-actions">
					<button class="primary" type="submit" disabled={busy}>
						{busy ? `${tr("Saving")}…` : tr("Save login")}
					</button>
					<button type="button" disabled={busy} onClick={close}>
						{tr("Cancel")}
					</button>
				</div>
			</form>
		</DialogSurface>
	);
}
