import { parseSqlScript } from "@lix-js/sdk/workerd";
import { Container } from "@cloudflare/containers";
import { handleRequest } from "./handler";

type ContainerProps = Record<string, never>;

export interface Env {
	SLATEDB_CONTAINER: DurableObjectNamespace<SlateDbContainer>;
	SUPABASE_URL?: string;
	SUPABASE_PUBLISHABLE_KEY?: string;
	SUPABASE_JWKS_URL?: string;
	R2_ENDPOINT?: string;
	R2_BUCKET?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_REGION?: string;
	SLATEDB_STORAGE?: string;
	SLATEDB_CACHE_DIR?: string;
	SLATEDB_CACHE_MAX_BYTES?: string;
	SLATEDB_BLOCK_CACHE_BYTES?: string;
	SLATEDB_METADATA_CACHE_BYTES?: string;
	LIXRAY_DEMO?: string;
	LIXRAY_DEMO_WORKSPACE_IDS?: string;
	GOOGLE_ANALYTICS_ID?: string;
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
}

export class SlateDbContainer extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "336h";

	constructor(ctx: DurableObjectState<ContainerProps>, env: Env) {
		super(ctx, env);
		this.sleepAfter = env.SLATEDB_STORAGE === "memory" ? "10m" : "336h";
		this.envVars = baseContainerEnv(env);
	}
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		return handleRequest(request, env, {
			executionContext: ctx,
			parseSqlScript,
		});
	},
};

function baseContainerEnv(env: Env): Record<string, string> {
	const vars: Record<string, string> = {};
	addOptionalEnv(vars, "R2_ENDPOINT", env.R2_ENDPOINT);
	addOptionalEnv(vars, "R2_BUCKET", env.R2_BUCKET);
	addOptionalEnv(vars, "R2_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID);
	addOptionalEnv(vars, "R2_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY);
	addOptionalEnv(vars, "R2_REGION", env.R2_REGION);
	addOptionalEnv(vars, "SLATEDB_STORAGE", env.SLATEDB_STORAGE);
	addOptionalEnv(vars, "SLATEDB_CACHE_DIR", env.SLATEDB_CACHE_DIR);
	addOptionalEnv(vars, "SLATEDB_CACHE_MAX_BYTES", env.SLATEDB_CACHE_MAX_BYTES);
	addOptionalEnv(
		vars,
		"SLATEDB_BLOCK_CACHE_BYTES",
		env.SLATEDB_BLOCK_CACHE_BYTES,
	);
	addOptionalEnv(
		vars,
		"SLATEDB_METADATA_CACHE_BYTES",
		env.SLATEDB_METADATA_CACHE_BYTES,
	);
	return vars;
}

function addOptionalEnv(
	vars: Record<string, string>,
	name: string,
	value: string | undefined,
) {
	if (value !== undefined) {
		vars[name] = value;
	}
}
