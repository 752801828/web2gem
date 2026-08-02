import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { configureBrowserLogin } from "../actions";
import { tr } from "../i18n";
import { browserCredentialsDraft } from "../state";
import type { BrowserCredentialsInput } from "../types";
import { DialogSurface } from "./DialogSurface";

type BrowserCredentialBuffer = {
	values: BrowserCredentialsInput;
	clear(): void;
};

function createBrowserCredentialBuffer(): BrowserCredentialBuffer {
	const values = { email: "", password: "", totpSecret: "" };
	return {
		values,
		clear() {
			values.email = "";
			values.password = "";
			values.totpSecret = "";
		},
	};
}

export function BrowserCredentialsModal(): JSX.Element | null {
	const draft = browserCredentialsDraft.value;
	const bufferRef = useRef<BrowserCredentialBuffer | null>(null);
	bufferRef.current ??= createBrowserCredentialBuffer();
	const buffer = bufferRef.current;
	const mounted = useRef(true);
	const [, render] = useState(0);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			buffer.clear();
		};
	}, [buffer]);
	if (!draft) return null;

	const clear = (): void => {
		buffer.clear();
		render((value) => value + 1);
	};
	const update = (
		field: keyof BrowserCredentialsInput,
		value: string,
	): void => {
		buffer.values[field] = value;
		render((current) => current + 1);
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
			saved = await configureBrowserLogin(draft.accountId, buffer.values);
		} finally {
			buffer.clear();
			if (mounted.current) {
				render((value) => value + 1);
				setBusy(false);
				if (
					saved &&
					browserCredentialsDraft.value?.accountId === draft.accountId
				)
					browserCredentialsDraft.value = null;
			}
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
						name="email"
						autoComplete="username"
						spellcheck={false}
						required={!draft.credentialsConfigured}
						value={buffer.values.email}
						onInput={(event) =>
							update("email", (event.currentTarget as HTMLInputElement).value)
						}
					/>
				</label>
				<label>
					{tr("Password")}
					<input
						type="password"
						name="password"
						autoComplete="current-password"
						required={!draft.credentialsConfigured}
						value={buffer.values.password}
						onInput={(event) =>
							update(
								"password",
								(event.currentTarget as HTMLInputElement).value,
							)
						}
					/>
				</label>
				<label>
					{tr("Authenticator seed")}
					<input
						type="password"
						name="totpSecret"
						autoComplete="one-time-code"
						required={!draft.credentialsConfigured}
						value={buffer.values.totpSecret}
						onInput={(event) =>
							update(
								"totpSecret",
								(event.currentTarget as HTMLInputElement).value,
							)
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
