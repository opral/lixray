export type RemoteLixWorkspaceFetch = (
	path: string,
	request: Request,
) => Promise<Response>;

type RemoteLixProtocolRoute = {
	method: "GET" | "POST";
	internalPath: string;
	response: "handshake" | "execute" | "passthrough";
};

const REMOTE_LIX_PROTOCOL_ROUTES: Record<string, RemoteLixProtocolRoute> = {
	"": {
		method: "GET",
		internalPath: "/branches",
		response: "handshake",
	},
	execute: {
		method: "POST",
		internalPath: "/execute",
		response: "execute",
	},
	observe: {
		method: "POST",
		internalPath: "/observe",
		response: "passthrough",
	},
	"branch/create": {
		method: "POST",
		internalPath: "/createBranch",
		response: "passthrough",
	},
	"branch/switch": {
		method: "POST",
		internalPath: "/switchBranch",
		response: "passthrough",
	},
};

export function remoteLixProtocolRoute(
	endpoint: string,
): RemoteLixProtocolRoute | null {
	return REMOTE_LIX_PROTOCOL_ROUTES[endpoint] ?? null;
}

export async function handleRemoteLixProtocolRequest(
	request: Request,
	endpoint: string,
	fetchWorkspace: RemoteLixWorkspaceFetch,
): Promise<Response> {
	const route = remoteLixProtocolRoute(endpoint);
	if (!route) return new Response("Not found\n", { status: 404 });
	if (request.method !== route.method) {
		return new Response("Method not allowed\n", { status: 405 });
	}

	const response = await fetchWorkspace(route.internalPath, request);
	if (!response.ok || route.response === "passthrough") return response;

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return protocolError("Workspace runtime returned invalid JSON.");
	}

	if (route.response === "handshake") {
		const currentBranchId = recordString(body, "currentBranchId");
		return currentBranchId
			? Response.json({ protocolVersion: 1, activeBranchId: currentBranchId })
			: protocolError("Workspace runtime returned an invalid current branch.");
	}

	const results = recordField(body, "results");
	if (
		!Array.isArray(results) ||
		results.length !== 1 ||
		!isRecord(results[0])
	) {
		return protocolError(
			"Workspace runtime returned an invalid single-statement result.",
		);
	}
	return Response.json(results[0]);
}

function recordString(value: unknown, key: string): string | null {
	const field = recordField(value, key);
	return typeof field === "string" && field.length > 0 ? field : null;
}

function recordField(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function protocolError(message: string): Response {
	return Response.json(
		{
			error: {
				code: "LIX_REMOTE_PROTOCOL_ERROR",
				message,
			},
		},
		{ status: 502 },
	);
}
