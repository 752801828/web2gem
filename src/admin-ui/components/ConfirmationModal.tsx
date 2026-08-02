import type { JSX } from "preact";
import { tr } from "../i18n";
import { destructiveConfirmationText } from "../logic";
import { resolveConfirmation } from "../session";
import { confirmationDraft } from "../state";
import { DialogSurface } from "./DialogSurface";

export function ConfirmationModal(): JSX.Element | null {
	const draft = confirmationDraft.value;
	if (!draft) return null;
	const copy =
		draft.action === "delete"
			? destructiveConfirmationText(draft.count, draft.targetLabel)
			: {
					title: tr(
						draft.action === "clear_browser_credentials"
							? "Clear browser credentials title"
							: "Delete browser profile title",
					),
					description: `${tr("Browser destructive target", {
						label: draft.accountLabel,
					})}. ${tr(
						draft.action === "clear_browser_credentials"
							? "Clear browser credentials description"
							: "Delete browser profile description",
					)}`,
					confirmLabel: tr(
						draft.action === "clear_browser_credentials"
							? "Clear credentials"
							: "Delete browser profile",
					),
				};
	return (
		<DialogSurface
			labelledBy="confirm-title"
			describedBy="confirm-description"
			onClose={() => resolveConfirmation(false)}
		>
			<div class="dialog-head">
				<div>
					<div id="confirm-title" class="dialog-title">
						{copy.title}
					</div>
					<p id="confirm-description" class="dialog-copy">
						{copy.description}
					</p>
				</div>
			</div>
			<div class="actions dialog-actions">
				<button
					type="button"
					class="danger danger-solid"
					onClick={() => resolveConfirmation(true)}
				>
					{copy.confirmLabel}
				</button>
				<button
					type="button"
					data-dialog-initial
					onClick={() => resolveConfirmation(false)}
				>
					{tr("Cancel")}
				</button>
			</div>
		</DialogSurface>
	);
}
