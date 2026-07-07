import { createClerkClient } from "@clerk/backend";

export interface WorkerEnv {
	SLATEDB_CONTAINER: ContainerNamespace;
	CLERK_SECRET_KEY?: string;
	VITE_CLERK_PUBLISHABLE_KEY?: string;
	R2_ENDPOINT?: string;
	R2_BUCKET?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	R2_REGION?: string;
	SLATEDB_STORAGE?: string;
}

export interface ContainerNamespace {
	getByName(name: string): ContainerStub;
}

export interface ContainerStub {
	startAndWaitForPorts?(options: {
		startOptions: { envVars: Record<string, string> };
	}): Promise<unknown>;
	fetch(request: Request): Promise<Response>;
}

export interface HandleRequestOptions {
	authenticate?: AuthenticateRequest;
	fallback?: (request: Request, env: WorkerEnv) => Promise<Response>;
}

export type AuthenticateRequest = (
	request: Request,
	env: WorkerEnv,
) => Promise<AuthResult>;

export type AuthResult =
	| { ok: true; orgId: string }
	| { ok: false; response: Response };

export async function handleRequest(
	request: Request,
	env: WorkerEnv,
	options: HandleRequestOptions = {},
): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/healthz") {
		return json({ ok: true, service: "lixray" });
	}

	if (!url.pathname.startsWith("/v1/")) {
		return options.fallback?.(request, env) ?? new Response("Not found\n", { status: 404 });
	}

	const authenticate = options.authenticate ?? authenticateWithClerk;
	const auth = await authenticate(request, env);
	if (!auth.ok) {
		return auth.response;
	}

	const container = env.SLATEDB_CONTAINER.getByName(auth.orgId);
	await container.startAndWaitForPorts?.({
		startOptions: {
			envVars: containerEnv(env, auth.orgId),
		},
	});
	return container.fetch(request);
}

export async function authenticateWithClerk(
	request: Request,
	env: WorkerEnv,
): Promise<AuthResult> {
	if (!env.CLERK_SECRET_KEY) {
		return {
			ok: false,
			response: new Response("CLERK_SECRET_KEY is not configured\n", {
				status: 500,
			}),
		};
	}

	if (!env.VITE_CLERK_PUBLISHABLE_KEY) {
		return {
			ok: false,
			response: new Response("VITE_CLERK_PUBLISHABLE_KEY is not configured\n", {
				status: 500,
			}),
		};
	}

	const client = createClerkClient({
		secretKey: env.CLERK_SECRET_KEY,
		publishableKey: env.VITE_CLERK_PUBLISHABLE_KEY,
	});
	const requestState = await client.authenticateRequest(request);

	if (!requestState.isAuthenticated) {
		return {
			ok: false,
			response: new Response("Unauthorized\n", {
				status: 401,
				headers: {
					"WWW-Authenticate": "Bearer",
				},
			}),
		};
	}

	const auth = requestState.toAuth();
	if (!auth.orgId) {
		return {
			ok: false,
			response: new Response("Active workspace required\n", {
				status: 403,
			}),
		};
	}

	return { ok: true, orgId: auth.orgId };
}

export function containerEnv(
	env: WorkerEnv,
	orgId: string,
): Record<string, string> {
	const vars = {
		SLATEDB_PATH: orgId,
	};
	addOptionalEnv(vars, "R2_ENDPOINT", env.R2_ENDPOINT);
	addOptionalEnv(vars, "R2_BUCKET", env.R2_BUCKET);
	addOptionalEnv(vars, "R2_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID);
	addOptionalEnv(vars, "R2_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY);
	addOptionalEnv(vars, "R2_REGION", env.R2_REGION);
	addOptionalEnv(vars, "SLATEDB_STORAGE", env.SLATEDB_STORAGE);
	return vars;
}

function json(value: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(value), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...init?.headers,
		},
	});
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
