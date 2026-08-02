import * as v from "valibot";

const issueSchema = v.union([
	v.literal("auth"),
	v.literal("rate_limit"),
	v.literal("user_action"),
	v.literal("location"),
	v.literal("transient"),
]);

const stateSchema = v.union([
	v.literal("available"),
	v.literal("cooling"),
	v.literal("attention"),
	v.literal("disabled"),
]);

const nullableNumber = v.nullable(v.number());

const browserStateSchema = v.union([
	v.literal("idle"),
	v.literal("checking"),
	v.literal("ready"),
	v.literal("login_required"),
	v.literal("manual_action_required"),
	v.literal("error"),
]);

const browserStatusSchema = v.strictObject({
	credentialsConfigured: v.boolean(),
	state: browserStateSchema,
	lastCheckAtMs: nullableNumber,
	lastCookieUpdateAtMs: nullableNumber,
	lastAutoLoginAtMs: nullableNumber,
	failureCode: v.nullable(v.string()),
});

const browserAdminStatusSchema = v.strictObject({
	credentialsConfigured: v.boolean(),
	status: v.strictObject({
		state: browserStateSchema,
		lastCheckAtMs: nullableNumber,
		lastCookieUpdateAtMs: nullableNumber,
		lastAutoLoginAtMs: nullableNumber,
		failureCode: v.nullable(v.string()),
	}),
});

const browserOpenSchema = v.strictObject({ url: v.string() });
const browserStoppedSchema = v.strictObject({ stopped: v.boolean() });
const browserProfileDeletedSchema = v.strictObject({ deleted: v.boolean() });

const accountSchema = v.strictObject({
	id: v.string(),
	label: v.nullable(v.string()),
	enabled: v.boolean(),
	state: stateSchema,
	issue: v.nullable(issueSchema),
	cooldown_until_ms: nullableNumber,
	last_issue_at_ms: nullableNumber,
	last_used_at_ms: nullableNumber,
	last_refresh_at_ms: nullableNumber,
	status_checked_at_ms: nullableNumber,
	last_refresh_success_at_ms: nullableNumber,
	created_at_ms: v.number(),
	updated_at_ms: v.number(),
	browser: browserStatusSchema,
});

const statsSchema = v.strictObject({
	total: v.number(),
	available: v.number(),
	cooling: v.number(),
	attention: v.number(),
	disabled: v.number(),
});

const mutationErrorSchema = v.strictObject({
	id: v.optional(v.string()),
	code: v.string(),
	message: v.string(),
});

const mutationSchema = v.strictObject({
	processed: v.number(),
	changed: v.number(),
	unchanged: v.number(),
	failed: v.number(),
	errors: v.optional(v.array(mutationErrorSchema)),
});

const overviewSchema = v.strictObject({
	items: v.array(accountSchema),
	nextCursor: v.nullable(v.string()),
	limit: v.number(),
	stats: statsSchema,
});

const modelFamilySchema = v.union([
	v.literal("pro"),
	v.literal("flash"),
	v.literal("flash_lite"),
]);
const modelRouteSchema = v.strictObject({
	providerModelId: v.string(),
	capacity: v.union([v.literal(1), v.literal(2), v.literal(3), v.literal(4)]),
	capacityField: v.union([v.literal(12), v.literal(13)]),
	modelNumber: v.number(),
	label: v.nullable(
		v.union([v.literal("Basic"), v.literal("Plus"), v.literal("Advanced")]),
	),
	available: v.boolean(),
	configured: v.boolean(),
	accountCount: v.number(),
});
const modelRoutingFamilySchema = v.strictObject({
	family: modelFamilySchema,
	publicNames: v.tuple([v.string(), v.string()]),
	configured: v.boolean(),
	routes: v.array(modelRouteSchema),
});
const modelRoutingSchema = v.strictObject({
	version: v.pipe(v.string(), v.regex(/^\d+$/)),
	families: v.array(modelRoutingFamilySchema),
});

export type GeminiAccountIssue = v.InferOutput<typeof issueSchema>;
export type GeminiAccountState = v.InferOutput<typeof stateSchema>;
export type BrowserState = v.InferOutput<typeof browserStateSchema>;
export type BrowserAccountStatus = v.InferOutput<typeof browserStatusSchema>;
export type BrowserAdminStatus = v.InferOutput<typeof browserAdminStatusSchema>;
export type GeminiAccount = v.InferOutput<typeof accountSchema>;
export type AccountStats = v.InferOutput<typeof statsSchema>;
export type MutationError = v.InferOutput<typeof mutationErrorSchema>;
export type MutationResult = v.InferOutput<typeof mutationSchema>;
export type AccountOverview = v.InferOutput<typeof overviewSchema>;
export type ModelFamily = v.InferOutput<typeof modelFamilySchema>;
export type ModelRoutingRoute = v.InferOutput<typeof modelRouteSchema>;
export type ModelRoutingFamily = v.InferOutput<typeof modelRoutingFamilySchema>;
export type ModelRoutingOverview = v.InferOutput<typeof modelRoutingSchema>;

export function parseMutation(value: unknown): MutationResult {
	const parsed = v.safeParse(mutationSchema, value);
	if (!parsed.success) throw new Error("admin mutation response is invalid");
	return parsed.output;
}

export function parseOverview(value: unknown): AccountOverview {
	const parsed = v.safeParse(overviewSchema, value);
	if (!parsed.success)
		throw new Error("admin account overview response is invalid");
	return parsed.output;
}

export function parseModelRoutingOverview(
	value: unknown,
): ModelRoutingOverview {
	const parsed = v.safeParse(modelRoutingSchema, value);
	if (!parsed.success)
		throw new Error("admin model routing response is invalid");
	return parsed.output;
}

export function parseBrowserAdminStatus(value: unknown): BrowserAdminStatus {
	const parsed = v.safeParse(browserAdminStatusSchema, value);
	if (!parsed.success)
		throw new Error("admin browser status response is invalid");
	return parsed.output;
}

export function parseBrowserOpen(value: unknown): { url: string } {
	const parsed = v.safeParse(browserOpenSchema, value);
	if (!parsed.success)
		throw new Error("admin browser open response is invalid");
	return parsed.output;
}

export function parseBrowserStopped(value: unknown): void {
	const parsed = v.safeParse(browserStoppedSchema, value);
	if (!parsed.success || !parsed.output.stopped)
		throw new Error("admin browser stop response is invalid");
}

export function parseBrowserProfileDeleted(value: unknown): void {
	const parsed = v.safeParse(browserProfileDeletedSchema, value);
	if (!parsed.success || !parsed.output.deleted)
		throw new Error("admin browser profile response is invalid");
}
