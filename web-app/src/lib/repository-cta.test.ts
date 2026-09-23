import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPOSITORY_HOME_PATH, repositoryCtaHref } from "./repository-cta.ts";

void test("marketing CTA opens the repository entry route", () => {
	assert.equal(REPOSITORY_HOME_PATH, "/open");
	assert.equal(repositoryCtaHref(true), "/open");
	assert.equal(repositoryCtaHref(false), "/sign-in?returnTo=%2Fopen");
	assert.doesNotMatch(repositoryCtaHref(true), /\/@/);
});

void test("landing and header CTAs use the repository entry route", () => {
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
