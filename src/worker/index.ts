import { Container } from "@cloudflare/containers";
import { handleRequest } from "./handler";

export interface Env {
	SLATEDB_CONTAINER: DurableObjectNamespace<SlateDbContainer>;
	CLERK_APP_ID?: string;
	CLERK_SECRET_KEY?: string;
	CLERK_PUBLISHABLE_KEY?: string;
	VITE_CLERK_PUBLISHABLE_KEY?: string;
	R2_ENDPOINT?: string;
	R2_BUCKET?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_REGION?: string;
	SLATEDB_STORAGE?: string;
}

export class SlateDbContainer extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "10m";

	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.envVars = baseContainerEnv(env);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return handleRequest(request, env);
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
