import { handleApplicationRequest } from "./app";
import { assertRuntimeConfig } from "./config";

const app = {
	fetch: handleApplicationRequest,
	assertRuntimeConfig,
};

export default app;
