import assert from "node:assert/strict";
import test from "node:test";

import { classifyCiChanges } from "./classify-ci-changes.mjs";

const all = {
  frontend: true,
  database: true,
  rust: true,
  e2e: true,
};

test("documentation-only changes skip expensive validation lanes", () => {
  assert.deepEqual(
    classifyCiChanges(["README.md", "docs/mcp.md", "reports/example/report.md", "perf/README.md"]),
    {
      frontend: false,
      database: false,
      rust: false,
      e2e: false,
    },
  );
});

test("web changes run frontend and end-to-end validation", () => {
  assert.deepEqual(classifyCiChanges(["web-app/src/start.ts"]), {
    frontend: true,
    database: false,
    rust: false,
    e2e: true,
  });
});

test("database changes run database and end-to-end validation", () => {
  assert.deepEqual(classifyCiChanges(["database/supabase/migrations/example.sql"]), {
    frontend: false,
    database: true,
    rust: false,
    e2e: true,
  });
});

test("server changes run Rust and end-to-end validation", () => {
  assert.deepEqual(classifyCiChanges(["lix-server/src/main.rs"]), {
    frontend: false,
    database: false,
    rust: true,
    e2e: true,
  });
});

test("vendored Lix changes cover every Lix consumer", () => {
  assert.deepEqual(classifyCiChanges(["vendor/lix"]), {
    frontend: true,
    database: false,
    rust: true,
    e2e: true,
  });
});

test("workflow and unknown changes fail safe by running every lane", () => {
  assert.deepEqual(classifyCiChanges([".github/workflows/pr.yml"]), all);
  assert.deepEqual(classifyCiChanges(["new-component/config.toml"]), all);
});

test("multiple changes union their required lanes", () => {
  assert.deepEqual(classifyCiChanges(["web-app/src/start.ts", "database/supabase/config.toml"]), {
    frontend: true,
    database: true,
    rust: false,
    e2e: true,
  });
});
