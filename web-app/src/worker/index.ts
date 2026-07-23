import { parseSqlScript } from "@lix-js/sdk/workerd";
import { Container } from "@cloudflare/containers";
import { handleRequest } from "./handler";

type ContainerProps = Record<string, never>;

export interface Env {
	SLATEDB_CONTAINER: DurableObjectNamespace<SlateDbContainer>;
	SUPABASE_URL?: string;
	SUPABASE_PUBLISHABLE_KEY?: string;
	SUPABASE_JWKS_URL?: string;
	SUPABASE_JWT_ISSUER_URL?: string;
	R2_ENDPOINT?: string;
	R2_BUCKET?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_REGION?: string;
	S3_PREFIX?: string;
	S3_ALLOW_HTTP?: string;
	SLATEDB_CACHE_DIR?: string;
	SLATEDB_CACHE_MAX_BYTES?: string;
	SLATEDB_BLOCK_CACHE_BYTES?: string;
	SLATEDB_METADATA_CACHE_BYTES?: string;
	LIXRAY_DEMO?: string;
	LIXRAY_DEMO_LIX_IDS?: string;
	GOOGLE_ANALYTICS_ID?: string;
	POSTHOG_PROJECT_TOKEN?: string;
	POSTHOG_HOST?: string;
	POSTHOG_ENVIRONMENT?: string;
	LIXRAY_RELEASE_ID?: string;
	RAILWAY_ENVIRONMENT_NAME?: string;
	CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export class SlateDbContainer extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "336h";

	constructor(ctx: DurableObjectState<ContainerProps>, env: Env) {
		super(ctx, env);
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
	addOptionalEnv(vars, "S3_ENDPOINT", env.R2_ENDPOINT);
	addOptionalEnv(vars, "S3_BUCKET", env.R2_BUCKET);
	addOptionalEnv(vars, "S3_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID);
	addOptionalEnv(vars, "S3_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY);
	addOptionalEnv(vars, "S3_REGION", env.R2_REGION);
	addOptionalEnv(vars, "S3_PREFIX", env.S3_PREFIX);
	addOptionalEnv(vars, "S3_ALLOW_HTTP", env.S3_ALLOW_HTTP);
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
