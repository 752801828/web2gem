import { handleApplicationRequest } from "./app";
import { assertRuntimeConfig } from "./config";

export default {
	fetch: handleApplicationRequest,
	assertRuntimeConfig,
} satisfies ExportedHandler<WorkerBindings> & {
	assertRuntimeConfig: typeof assertRuntimeConfig;
};
