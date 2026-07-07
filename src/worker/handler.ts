export interface WorkerEnv {
	SLATEDB_CONTAINER: ContainerNamespace;
	LIXRAY_AUTH_TOKEN?: string;
}

export interface ContainerNamespace {
	getByName(name: string): ContainerStub;
}

export interface ContainerStub {
	fetch(request: Request): Promise<Response>;
}

export async function handleRequest(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	const url = new URL(request.url);

	if (request.method === "GET" && url.pathname === "/healthz") {
		return json({ ok: true, service: "lixray" });
	}

	if (!url.pathname.startsWith("/v1/")) {
		return new Response("Not found\n", { status: 404 });
	}

	const authFailure = authenticate(request, env);
	if (authFailure) {
		return authFailure;
	}

	const container = env.SLATEDB_CONTAINER.getByName("default");
	return container.fetch(request);
}

function authenticate(request: Request, env: WorkerEnv): Response | null {
	if (!env.LIXRAY_AUTH_TOKEN) {
		return new Response("LIXRAY_AUTH_TOKEN is not configured\n", {
			status: 500,
		});
	}

	const expected = `Bearer ${env.LIXRAY_AUTH_TOKEN}`;
	if (request.headers.get("Authorization") !== expected) {
		return new Response("Unauthorized\n", {
			status: 401,
			headers: {
				"WWW-Authenticate": "Bearer",
			},
		});
	}

	return null;
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
