// Entry for the smoke/bench harness bundle (dist/harness.js).
// Exports only what scripts/smoke.mjs and scripts/bench.mjs consume;
// unit tests import src modules directly and must not use this surface.
export { default } from "./index";
export { VERSION } from "./config";
export { MODELS, resolveModel } from "./models";
export { base64ToBytes } from "./attachments/bytes";
export { prepareOpenAIGeminiContext } from "./completion/context";
export { finalizeStructuredOutputText } from "./completion/structured-output";
export { getConfig } from "./config";
export { GeminiAccountAdminService } from "./gemini/accounts/admin";
export { generateStream } from "./gemini/client";
export { createStreamTextExtractor } from "./gemini/client/parse-stream";
export { buildPayload } from "./gemini/client/protocol";
export { refreshGeminiBuildLabelForRetry } from "./gemini/client/retry";
export { createByteQueue } from "./gemini/transport/byte-queue";
export { socketHttp } from "./gemini/transport/socket";
export { attachmentDedupeKey as attachmentDedupeKeyForTest } from "./gemini/uploads/execute";
export { uploadMultipartFile } from "./gemini/uploads/multipart";
export {
	getPageTokens,
	resetGeminiUploadCachesForTest,
} from "./gemini/uploads/tokens";
export { readJsonRequest } from "./http/core/json";
export { sseResponse } from "./http/core/sse";
export { streamGooglePlain } from "./http/google/stream";
export { streamResponsesWithToolSieve } from "./http/openai/responses-stream";
export { parseOpenAIMessages } from "./promptcompat/message-model";
export { messagesToPrompt } from "./promptcompat/prompt";
export { randHex } from "./shared/crypto";
export { parseToolCalls } from "./toolcall/parse";
export { maskMarkdownProtectedSpans } from "./toolcall/parse";
export { buildToolCallInstructions } from "./toolcall/tool-bundle";
export { createToolBundle } from "./toolcall/tool-bundle";
export {
	createToolSieveState,
	flushToolSieve,
	processToolSieveChunk,
} from "./toolcall/sieve";
