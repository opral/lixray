import assert from "node:assert/strict";
import test from "node:test";

import { classifyCiChanges } from "./classify-ci-changes.mjs";

const all = {
  fast: true,
  frontend: true,
  database: true,
  e2e: true,
  deploy: true,
  tooling: true,
};

test("documentation-only changes skip expensive validation lanes", () => {
  assert.deepEqual(
    classifyCiChanges(["README.md", "docs/mcp.md", "reports/example/report.md", "perf/README.md"]),
    {
      fast: false,
      frontend: false,
      database: false,
      e2e: false,
      deploy: false,
      tooling: false,
    },
  );
});

test("web changes run frontend and end-to-end validation", () => {
  assert.deepEqual(classifyCiChanges(["web-app/src/start.ts"]), {
    fast: false,
    frontend: true,
    database: false,
    e2e: true,
  deploy: true,
  tooling: false,
  });
});

test("database changes run database and end-to-end validation", () => {
  assert.deepEqual(classifyCiChanges(["database/supabase/migrations/example.sql"]), {
    fast: false,
    frontend: false,
    database: true,
    e2e: true,
  deploy: true,
  tooling: false,
  });
});

test("vendored Lix changes cover its remaining frontend consumers", () => {
  assert.deepEqual(classifyCiChanges(["vendor/lix"]), {
    fast: false,
    frontend: true,
    database: false,
    e2e: true,
  deploy: true,
  tooling: true,
  });
});

test("shared actions and unknown changes run every lane", () => {
  assert.deepEqual(classifyCiChanges([".github/actions/setup-web/action.yml"]), all);
  assert.deepEqual(classifyCiChanges(["new-component/config.toml"]), all);
});

test("multiple changes union their required lanes", () => {
  assert.deepEqual(classifyCiChanges(["web-app/src/start.ts", "database/supabase/config.toml"]), {
    fast: false,
    frontend: true,
    database: true,
    e2e: true,
  deploy: true,
  tooling: false,
  });
});

test("icon metadata and artwork deploy without integration tests", () => {
  assert.deepEqual(classifyCiChanges([
    "web-app/src/pwa-icons.json", "web-app/public/lixray-icon-192-deadbeef.png",
    "web-app/public/manifest.webmanifest",
  ], { manifestIconsOnly: true }), {
    fast: false,
    frontend: false, database: false, e2e: false, deploy: true, tooling: false,
  });
});

test("application shell, arbitrary public files and non-icon manifest changes retain integration coverage", () => {
  for (const file of ["web-app/src/routes/__root.tsx", "web-app/public/service-worker.js", "web-app/public/manifest.webmanifest"]) {
    assert.equal(classifyCiChanges([file]).e2e, true, file);
  }
});

test("deleted and renamed application inputs are included in the Git diff", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "ci-selection-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git("init"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
    mkdirSync(join(root, "web-app/src"), { recursive: true });
    writeFileSync(join(root, "web-app/src/start.ts"), "export {};");
    git("add", "."); git("commit", "-m", "base");
    git("mv", "web-app/src/start.ts", "README.md"); git("commit", "-m", "rename into docs");
    const output = execFileSync(process.execPath, [resolve(import.meta.dirname, "classify-ci-changes.mjs")], { cwd: root, encoding: "utf8", stdio: "pipe" });
    assert.match(output, /web-app\/src\/start.ts/);
    assert.match(output, /e2e=true/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("database validation follows SQL and its pinned runner, not the JS lockfile", () => {
  assert.equal(classifyCiChanges(["pnpm-lock.yaml"]).database, false);
  assert.equal(classifyCiChanges([".github/workflows/production-canary.yml"]).database, false);
  for (const file of ["database/supabase/config.toml", ".github/scripts/test-database.sh", ".github/actions/setup-web/action.yml"]) {
    assert.equal(classifyCiChanges([file]).database, true, file);
  }
});

test("performance tooling changes need no application build", () => {
  assert.deepEqual(classifyCiChanges(["perf/runner.mjs"]), {
    fast: false,
    frontend: false, database: false, e2e: false, deploy: false, tooling: true,
  });
  assert.equal(classifyCiChanges(["web-app/src/start.ts"]).tooling, false);
  assert.equal(classifyCiChanges(["scripts/dev.mjs"]).tooling, true);
});

test("static public UI changes only select fast checks", () => {
  for (const file of [
    "web-app/src/components/landing-page.tsx",
    "web-app/src/components/docs-page.tsx",
    "web-app/src/components/legal-page.tsx",
    "web-app/src/components/vs-github-page.tsx",
    "web-app/src/lib/docs-markdown.ts",
    "web-app/src/routes/docs.$slug.tsx",
    "web-app/src/routes/privacy.tsx",
    "web-app/src/styles.css",
    "web-app/public/landing/claude-spark.svg",
  ]) {
    assert.deepEqual(classifyCiChanges([file]), {
      fast: true, frontend: false, database: false, e2e: false, deploy: true, tooling: false,
    }, file);
  }
});

test("CI selection changes validate through tooling, including this PR", () => {
  const selectionFiles = [
    ".github/workflows/pr.yml",
    ".github/scripts/classify-ci-changes.mjs",
    ".github/scripts/classify-ci-changes.test.mjs",
    ".github/scripts/check-ci-results.mjs",
    ".github/scripts/check-ci-results.test.mjs",
    ".github/scripts/ci-workflow.test.mjs",
  ];
  assert.deepEqual(classifyCiChanges(selectionFiles), {
    fast: false, frontend: false, database: false, e2e: false, deploy: false, tooling: true,
  });
  assert.deepEqual(classifyCiChanges([...selectionFiles, "web-app/src/components/landing-page.tsx"]), {
    fast: true, frontend: false, database: false, e2e: false, deploy: true, tooling: true,
  });
});

test("UI edits never suppress integration coverage for mixed app changes", () => {
  for (const file of [
    "web-app/src/components/site-header.tsx",
    "web-app/src/components/repository-provider.tsx",
    "web-app/src/routes/index.tsx",
    "web-app/src/worker/handler.ts",
    "web-app/src/mcp/server.ts",
    "web-app/public/service-worker.js",
    "vendor/lix",
    "pnpm-lock.yaml",
  ]) {
    assert.equal(classifyCiChanges(["web-app/src/components/landing-page.tsx", file]).e2e, true, file);
  }
});
