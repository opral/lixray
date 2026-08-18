import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const script = resolve(import.meta.dirname, "cleanup-github-preview.sh");
const workflow = await readFile(
	resolve(repositoryRoot, ".github/workflows/railway-preview-cleanup.yml"),
	"utf8",
);

test("workflow splits Railway and GitHub cleanup and does not require an admin token", () => {
	assert.match(workflow, /manage-railway-preview\.sh delete/);
	assert.match(workflow, /cleanup-github-preview\.sh/);
	assert.match(workflow, /deployments:\s*write/);
	assert.match(workflow, /environments:\s*write/);
	assert.match(workflow, /secrets\.GITHUB_TOKEN/);
	assert.doesNotMatch(workflow, /GITHUB_ENVIRONMENT_ADMIN_TOKEN:\?/);
	assert.match(
		workflow,
		/cleanup-github:[\s\S]*name: Delete GitHub preview/,
	);
	assert.match(
		workflow,
		/cleanup-railway:[\s\S]*manage-railway-preview\.sh delete/,
	);
	assert.doesNotMatch(
		workflow,
		/cleanup-github:[\s\S]*needs:[\s\S]*cleanup-railway/,
	);
});

test("inactivates then deletes deployments for both preview environment names", async () => {
	const fixture = await createFixture("ok");
	const result = runCleanup(fixture);

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Deleted GitHub preview environment lixray-pr-231/);
	assert.match(
		result.stdout,
		/Deleted GitHub preview environment lixray \/ lixray-pr-231/,
	);

	const calls = await readFile(fixture.calls, "utf8");
	assert.match(
		calls,
		/workflow-token GET repos\/opral\/lixray\/deployments\?environment=lixray-pr-231/,
	);
	assert.match(
		calls,
		/workflow-token GET repos\/opral\/lixray\/deployments\?environment=lixray%20%2F%20lixray-pr-231/,
	);
	assert.match(
		calls,
		/workflow-token POST repos\/opral\/lixray\/deployments\/11\/statuses state=inactive/,
	);
	assert.match(
		calls,
		/workflow-token DELETE repos\/opral\/lixray\/deployments\/11/,
	);
	assert.match(
		calls,
		/workflow-token POST repos\/opral\/lixray\/deployments\/21\/statuses state=inactive/,
	);
	assert.match(
		calls,
		/workflow-token DELETE repos\/opral\/lixray\/deployments\/21/,
	);
	assert.match(
		calls,
		/workflow-token DELETE repos\/opral\/lixray\/environments\/lixray-pr-231/,
	);
	assert.match(
		calls,
		/workflow-token DELETE repos\/opral\/lixray\/environments\/lixray%20%2F%20lixray-pr-231/,
	);
	assert.doesNotMatch(calls, /admin-token/);
	assertProtectedNamesUntouched(calls);
});

test("treats already-absent environments as success without an admin token", async () => {
	const fixture = await createFixture("absent");
	const result = runCleanup(fixture, { GITHUB_ENVIRONMENT_ADMIN_TOKEN: "" });

	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stdout,
		/GitHub preview environment lixray-pr-231 is already absent/,
	);
	assert.match(
		result.stdout,
		/GitHub preview environment lixray \/ lixray-pr-231 is already absent/,
	);
	assert.doesNotMatch(result.stderr, /parameter null or not set/);
	assertProtectedNamesUntouched(await readFile(fixture.calls, "utf8"));
});

test("missing admin token is not a hard fail when GITHUB_TOKEN can delete", async () => {
	const fixture = await createFixture("ok");
	const result = runCleanup(fixture, { omitAdminToken: true });

	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /parameter null or not set/);
	assert.doesNotMatch(await readFile(fixture.calls, "utf8"), /admin-token/);
});

test("falls back to the optional admin token only after GITHUB_TOKEN is denied", async () => {
	const fixture = await createFixture("token-forbidden");
	const result = runCleanup(fixture);

	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stderr,
		/GITHUB_TOKEN was denied; retrying with GITHUB_ENVIRONMENT_ADMIN_TOKEN/,
	);
	const calls = await readFile(fixture.calls, "utf8");
	assert.match(calls, /workflow-token GET .*deployments\?environment=lixray-pr-231/);
	assert.match(calls, /admin-token GET .*deployments\?environment=lixray-pr-231/);
	assert.match(
		calls,
		/admin-token DELETE repos\/opral\/lixray\/environments\/lixray-pr-231/,
	);
	assertProtectedNamesUntouched(calls);
});

test("fails clearly when GITHUB_TOKEN is denied and no admin token is set", async () => {
	const fixture = await createFixture("forbidden");
	const result = runCleanup(fixture, { omitAdminToken: true });

	assert.equal(result.status, 1);
	assert.match(result.stderr, /HTTP 403/);
	assert.match(result.stderr, /environments: write/);
	assert.match(result.stderr, /GITHUB_ENVIRONMENT_ADMIN_TOKEN/);
	assert.doesNotMatch(result.stderr, /parameter null or not set/);
});

test("does not request production, preview, or other PR environments", async () => {
	const fixture = await createFixture("ok");
	const result = runCleanup(fixture);

	assert.equal(result.status, 0, result.stderr);
	assertProtectedNamesUntouched(await readFile(fixture.calls, "utf8"));
});

function assertProtectedNamesUntouched(calls) {
	assert.doesNotMatch(calls, /production/);
	assert.doesNotMatch(calls, /preview-base/);
	assert.doesNotMatch(calls, /lixray-pr-216/);
	assert.doesNotMatch(calls, /(?:^|[^\w-])preview(?:[^\w-]|[/?]|$)/);
}

async function createFixture(mode) {
	const directory = await mkdtemp(join(tmpdir(), "lixray-github-preview-"));
	const calls = join(directory, "calls");
	const gh = join(directory, "gh");
	await writeFile(calls, "");
	await writeFile(
		gh,
		`#!/usr/bin/env bash
set -euo pipefail
method="GET"
endpoint=""
fields=""
while test "$#" -gt 0; do
	case "$1" in
		--method) method="$2"; shift 2 ;;
		--paginate) shift ;;
		--jq) shift 2 ;;
		--field|-f)
			fields="$fields $2"
			shift 2
			;;
		--silent|--include) shift ;;
		--input) shift 2 ;;
		repos/*)
			endpoint="$1"
			shift
			;;
		*) shift ;;
	esac
done

token="\${GH_TOKEN:-}"
printf '%s %s %s%s\\n' "$token" "$method" "$endpoint" "$fields" >> "$MOCK_CALLS"

if [[ "$endpoint" =~ production|preview-base|lixray-pr-216 ]] || [[ "$endpoint" =~ /(preview)(\\?|$) ]]; then
	echo "refused to touch a protected environment: $endpoint" >&2
	exit 99
fi

if test "$MOCK_MODE" = forbidden || { test "$MOCK_MODE" = token-forbidden && test "$token" != admin-token; }; then
	echo "gh: Resource not accessible by integration (HTTP 403)" >&2
	exit 1
fi

if test "$MOCK_MODE" = absent; then
	if test "$method" = GET && [[ "$endpoint" == *"/deployments?"* ]]; then
		printf '[]\\n'
		exit 0
	fi
	echo "gh: Not Found (HTTP 404)" >&2
	exit 1
fi

if test "$method" = GET && [[ "$endpoint" == *"/deployments?environment=lixray-pr-231"* ]]; then
	printf '[{"id":11}]\\n'
	exit 0
fi
if test "$method" = GET && [[ "$endpoint" == *"/deployments?environment=lixray%20%2F%20lixray-pr-231"* ]]; then
	printf '[{"id":21}]\\n'
	exit 0
fi
if test "$method" = GET && [[ "$endpoint" == *"/deployments?"* ]]; then
	printf '[]\\n'
	exit 0
fi
if test "$method" = POST && [[ "$endpoint" == */statuses ]]; then
	printf '{"state":"inactive"}\\n'
	exit 0
fi
if test "$method" = DELETE; then
	exit 0
fi
echo "unhandled gh api call: $method $endpoint" >&2
exit 2
`,
	);
	await chmod(gh, 0o755);
	return { calls, directory, mode };
}

function runCleanup(fixture, options = {}) {
	const env = {
		...process.env,
		GITHUB_REPOSITORY: "opral/lixray",
		GITHUB_TOKEN: "workflow-token",
		MOCK_CALLS: fixture.calls,
		MOCK_MODE: fixture.mode,
		PATH: `${fixture.directory}:${process.env.PATH}`,
		PR_NUMBER: "231",
	};
	delete env.GH_TOKEN;
	if (options.omitAdminToken) {
		delete env.GITHUB_ENVIRONMENT_ADMIN_TOKEN;
		delete env.REPOSITORY_ADMIN_TOKEN;
	} else if ("GITHUB_ENVIRONMENT_ADMIN_TOKEN" in options) {
		env.GITHUB_ENVIRONMENT_ADMIN_TOKEN = options.GITHUB_ENVIRONMENT_ADMIN_TOKEN;
	} else {
		env.GITHUB_ENVIRONMENT_ADMIN_TOKEN = "admin-token";
	}
	return spawnSync("bash", [script], {
		cwd: repositoryRoot,
		encoding: "utf8",
		env,
	});
}
