import { Container } from "@cloudflare/containers";
import { handleRequest } from "./handler";

export interface Env {
	SLATEDB_CONTAINER: DurableObjectNamespace<SlateDbContainer>;
	LIXRAY_AUTH_TOKEN?: string;
	R2_ENDPOINT?: string;
	R2_BUCKET?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_REGION?: string;
	SLATEDB_PATH?: string;
	SLATEDB_STORAGE?: string;
}

export class SlateDbContainer extends Container<Env> {
	defaultPort = 8080;
	sleepAfter = "10m";

	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.envVars = {
			R2_ENDPOINT: env.R2_ENDPOINT ?? "",
			R2_BUCKET: env.R2_BUCKET ?? "",
			R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID ?? "",
			R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY ?? "",
			R2_REGION: env.R2_REGION ?? "auto",
			SLATEDB_PATH: env.SLATEDB_PATH ?? "lixray/default",
			SLATEDB_STORAGE: env.SLATEDB_STORAGE ?? "",
		};
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return handleRequest(request, env);
	},
};
