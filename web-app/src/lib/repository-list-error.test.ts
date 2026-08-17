import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeRepositoryListError,
	RepositoryListError,
	repositoryListTelemetryProperties,
} from "./repository-list-error.ts";

void test("extracts safe repository RPC failure fields", () => {
	const failure = new RepositoryListError("bootstrap_personal_namespace", {
		status: 400,
		error: {
			code: "P0001",
			message: "Profile not found: private@example.com",
			details: "secret response body",
			hint: "Bearer secret.jwt.value",
		},
	});
	const properties = repositoryListTelemetryProperties(failure);

	assert.equal(failure.message, "Unable to load repositories");
	assert.deepEqual(properties, {
		repository_operation: "bootstrap_personal_namespace",
		repository_request_endpoint: "/rest/v1/rpc/bootstrap_personal_namespace",
		repository_http_status: 400,
		supabase_error_code: "P0001",
	});
	assert.doesNotMatch(
		JSON.stringify({ message: failure.message, properties }),
		/private@example|secret|Bearer|response body/,
	);
});

void test("normalizes unknown failures without serializing their contents", () => {
	const failure = normalizeRepositoryListError({
		message: "private database response",
		response: { body: "private content" },
	});

	assert.equal(failure.name, "RepositoryListError");
	assert.equal(failure.message, "Unable to load repositories");
	assert.deepEqual(repositoryListTelemetryProperties(failure), {
		repository_operation: "repository_refresh",
		repository_request_endpoint: "client",
	});
});
