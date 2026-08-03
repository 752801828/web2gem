export async function pasteLocalClipboard(clipboard, textarea, send) {
	try {
		if (typeof clipboard?.readText !== "function") throw new Error("unavailable");
		const text = await clipboard.readText();
		textarea.value = text;
		send(text);
		return true;
	} catch {
		textarea.focus();
		return false;
	}
}

export async function copyRemoteClipboard(clipboard, textarea) {
	try {
		if (typeof clipboard?.writeText !== "function") throw new Error("unavailable");
		await clipboard.writeText(textarea.value);
		return true;
	} catch {
		textarea.focus();
		textarea.select();
		return false;
	}
}

async function installClipboardToolbar() {
	const { default: UI } = await import("./ui.js");
	const panel = document.getElementById("noVNC_clipboard");
	const textarea = document.getElementById("noVNC_clipboard_text");
	if (!(panel instanceof HTMLElement) || !(textarea instanceof HTMLTextAreaElement))
		return;

	const quick = document.createElement("button");
	quick.id = "web2gem_clipboard_quick";
	quick.type = "button";
	quick.textContent = "剪贴板";
	quick.addEventListener("click", () => UI.toggleClipboardPanel());
	document.body.append(quick);

	const actions = document.createElement("div");
	actions.id = "web2gem_clipboard_actions";
	const status = document.createElement("span");
	status.id = "web2gem_clipboard_status";
	const button = (label, action) => {
		const element = document.createElement("button");
		element.type = "button";
		element.textContent = label;
		element.addEventListener("click", action);
		return element;
	};
	actions.append(
		button("读取本机", async () => {
			const pasted = await pasteLocalClipboard(
				navigator.clipboard,
				textarea,
				(text) => UI.rfb?.clipboardPasteFrom(text),
			);
			status.textContent = pasted
				? "已发送到远端"
				: "请在文本框按 Ctrl+V，再点“发送到远端”";
		}),
		button("发送到远端", () => {
			UI.rfb?.clipboardPasteFrom(textarea.value);
			status.textContent = "已发送到远端";
		}),
		button("复制到本机", async () => {
			const copied = await copyRemoteClipboard(navigator.clipboard, textarea);
			status.textContent = copied ? "已复制" : "文本已选中，请按 Ctrl+C";
		}),
	);
	panel.append(actions, status);

	const style = document.createElement("style");
	style.textContent = `
		#web2gem_clipboard_quick {
			position: fixed; z-index: 10000; top: 12px; right: 12px;
			min-height: 34px; border: 1px solid #2f6fed; border-radius: 8px;
			background: #1557d6; padding: 6px 12px; color: white;
			font: 600 14px/1.2 sans-serif; cursor: pointer;
			box-shadow: 0 4px 16px rgb(0 0 0 / 24%);
		}
		:root:not(.noVNC_connected) #web2gem_clipboard_quick { display: none; }
		#web2gem_clipboard_actions { display: grid; grid-template-columns: 1fr; gap: 6px; margin-top: 8px; }
		#web2gem_clipboard_actions button { min-height: 32px; cursor: pointer; }
		#web2gem_clipboard_status { display: block; max-width: 260px; margin-top: 8px; font-size: 12px; line-height: 1.4; }
	`;
	document.head.append(style);
}

if (typeof document !== "undefined") installClipboardToolbar().catch(() => undefined);
