import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPOSITORY_HOME_PATH, repositoryCtaHref } from "./repository-cta.ts";

void test("marketing CTA always opens home, not the last repository", () => {
	assert.equal(REPOSITORY_HOME_PATH, "/home");
	assert.equal(repositoryCtaHref(true), "/home");
	assert.equal(repositoryCtaHref(false), "/sign-in?returnTo=%2Fhome");
	assert.doesNotMatch(repositoryCtaHref(true), /\/@/);
	assert.doesNotMatch(repositoryCtaHref(false), /\/open/);
});

void test("landing and header CTAs use the home destination", () => {
	const src = join(dirname(fileURLToPath(import.meta.url)), "..");
	const header = readFileSync(join(src, "components/site-header.tsx"), "utf8");
	assert.match(header, /repositoryCtaHref\(Boolean\(user\)\)/);
	assert.doesNotMatch(header, /repositoryPath/);
	assert.doesNotMatch(header, /activeRepository/);

	for (const file of ["landing-page.tsx", "vs-github-page.tsx"] as const) {
		const source = readFileSync(join(src, "components", file), "utf8");
		assert.match(source, /href=\{repositoryTo\}/, file);
		assert.doesNotMatch(source, /repositoryPath/, file);
	}

	const openRoute = readFileSync(join(src, "routes/open.tsx"), "utf8");
	assert.match(openRoute, /createFileRoute\("\/open"\)/);
	assert.match(openRoute, /activeRepository/);
	assert.match(openRoute, /repositoryPath/);
});
