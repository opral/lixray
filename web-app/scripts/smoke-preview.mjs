const baseUrl = process.argv[2]?.replace(/\/$/, "");
if (!baseUrl) throw new Error("Usage: node scripts/smoke-preview.mjs <url>");

const workspaceId = "00000000-0000-4000-8000-000000000002";
const headers = { Authorization: "Bearer lixray-demo" };

await retry(async () => {
	const response = await fetch(`${baseUrl}/healthz`);
	const body = await response.json();
	if (!response.ok || body.ok !== true) throw new Error("health check failed");
});

const page = await fetch(`${baseUrl}/`);
if (!page.ok || !(await page.text()).includes("Lixray")) {
	throw new Error("frontend shell failed to load");
}

const branchesResponse = await fetch(
	`${baseUrl}/v1/workspaces/${workspaceId}/branches`,
	{ headers },
);
const branches = await jsonResponse(branchesResponse, "branch listing");
const branchId =
	branches.branches?.find((branch) => branch.name === "main")?.id ??
	branches.branches?.[0]?.id;
if (!branchId) throw new Error("branch listing returned no branches");

const executeResponse = await fetch(
	`${baseUrl}/v1/workspaces/${workspaceId}/execute`,
	{
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({ branchId, sql: "SELECT 1 AS value", params: [] }),
	},
);
const result = await jsonResponse(executeResponse, "stateless SELECT");
if (result.rows?.[0]?.[0]?.value !== 1) {
	throw new Error("stateless SELECT returned an unexpected result");
}

async function jsonResponse(response, label) {
	const body = await response.json();
	if (!response.ok) {
		throw new Error(
			`${label} failed (${response.status}): ${JSON.stringify(body)}`,
		);
	}
	return body;
}

async function retry(operation) {
	let lastError;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 1_500));
		}
	}
	throw lastError;
}
