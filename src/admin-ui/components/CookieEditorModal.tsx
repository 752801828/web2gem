import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { loadAccountCookie, saveAccountCookie } from "../actions";
import { tr } from "../i18n";
import { accountCookieDraft } from "../state";
import type { AccountCookieInput } from "../types";
import { DialogSurface } from "./DialogSurface";

function emptyCookie(): AccountCookieInput {
	return { psid: "", psidts: "" };
}

export function CookieEditorModal(): JSX.Element | null {
	const draft = accountCookieDraft.value;
	const values = useRef<AccountCookieInput>(emptyCookie());
	const mounted = useRef(true);
	const [, render] = useState(0);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		mounted.current = true;
		void loadAccountCookie(draft?.accountId || "").then((cookie) => {
			if (!mounted.current) {
				if (cookie) Object.assign(cookie, emptyCookie());
				return;
			}
			if (cookie) values.current = cookie;
			setLoading(false);
			render((value) => value + 1);
		});
		return () => {
			mounted.current = false;
			Object.assign(values.current, emptyCookie());
		};
	}, []);
	if (!draft) return null;

	const clear = (): void => {
		values.current = emptyCookie();
		render((value) => value + 1);
	};
	const close = (): void => {
		if (busy) return;
		clear();
		accountCookieDraft.value = null;
	};
	const submit = async (event: Event): Promise<void> => {
		event.preventDefault();
		setBusy(true);
		let saved = false;
		try {
			saved = await saveAccountCookie(draft.accountId, values.current);
		} finally {
			values.current = emptyCookie();
			if (mounted.current) {
				render((value) => value + 1);
				setBusy(false);
				if (saved && accountCookieDraft.value?.accountId === draft.accountId)
					accountCookieDraft.value = null;
			}
		}
	};
	const update = (field: keyof AccountCookieInput, value: string): void => {
		values.current[field] = value;
		render((current) => current + 1);
	};

	return (
		<DialogSurface
			labelledBy="cookie-editor-title"
			describedBy="cookie-editor-help"
			onClose={close}
		>
			<div class="dialog-head">
				<div>
					<div id="cookie-editor-title" class="dialog-title">
						{tr("Edit CK")}
					</div>
					<div class="help">{draft.accountLabel}</div>
				</div>
				<button type="button" disabled={busy} onClick={close}>
					{tr("Close")}
				</button>
			</div>
			<p id="cookie-editor-help" class="dialog-copy">
				{tr("Cookie editor help")}
			</p>
			<form
				class="grid browser-credentials-form"
				aria-busy={busy || loading}
				onSubmit={submit}
			>
				<label>
					__Secure-1PSID
					<input
						data-dialog-initial
						type="text"
						autoComplete="off"
						spellcheck={false}
						required
						disabled={loading}
						value={values.current.psid}
						onInput={(event) =>
							update("psid", (event.currentTarget as HTMLInputElement).value)
						}
					/>
					<span class="field-note">{tr("Value only")}</span>
				</label>
				<label>
					__Secure-1PSIDTS
					<input
						type="text"
						autoComplete="off"
						spellcheck={false}
						required
						disabled={loading}
						value={values.current.psidts}
						onInput={(event) =>
							update("psidts", (event.currentTarget as HTMLInputElement).value)
						}
					/>
					<span class="field-note">{tr("Value only")}</span>
				</label>
				<div class="actions dialog-actions">
					<button class="primary" type="submit" disabled={busy || loading}>
						{loading ? tr("Loading CK") : busy ? tr("Saving") : tr("Save CK")}
					</button>
					<button type="button" disabled={busy} onClick={close}>
						{tr("Cancel")}
					</button>
				</div>
			</form>
		</DialogSurface>
	);
}
