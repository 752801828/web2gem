import { throwIfAborted, timeoutSignal } from "../../shared/abort";

type HttpBodyInit = BodyInit | ArrayBufferView;

type HttpFetchOptions = {
	method?: string;
	headers?: Record<string, string>;
	redirect?: RequestRedirect;
	body?: HttpBodyInit | null | undefined;
	bodyLength?: number | null | undefined;
	timeoutMs?: number;
	signal?: AbortSignal | null | undefined;
	cfg?: { log_requests?: unknown } | null;
	acceptCompressed?: boolean;
};

export async function httpFetch(
	url: string,
	{
		method = "GET",
		headers = {},
		redirect,
		body,
		timeoutMs = 180000,
		signal,
	}: HttpFetchOptions = {},
): Promise<Response> {
	throwIfAborted(signal);
	const linked = linkedFetchSignal(signal, timeoutSignal(timeoutMs));
	try {
		const init: RequestInit = { method, headers };
		if (redirect) init.redirect = redirect;
		if (body !== undefined) init.body = body as BodyInit;
		if (body instanceof ReadableStream)
			(init as RequestInit & { duplex?: "half" }).duplex = "half";
		if (linked.signal) init.signal = linked.signal;
		return await fetch(url, init);
	} finally {
		linked.cleanup();
	}
}

export async function cancelResponseBody(response: {
	body?: ReadableStream<Uint8Array> | null;
}): Promise<void> {
	if (!response.body) return;
	try {
		await response.body.cancel();
	} catch (_) {
		// Preserve the status/error that caused the response to be abandoned.
	}
}

function linkedFetchSignal(
	signal: AbortSignal | null | undefined,
	timeout: AbortSignal | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
	if (!signal) return { signal: timeout, cleanup() {} };
	if (!timeout) return { signal, cleanup() {} };
	return { signal: AbortSignal.any([signal, timeout]), cleanup() {} };
}
