import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ALL_LANES = ["fast", "frontend", "database", "e2e", "deploy", "tooling"];

export function classifyCiChanges(files, { manifestIconsOnly = false } = {}) {
  const lanes = Object.fromEntries(ALL_LANES.map((lane) => [lane, false]));

  for (const file of files) {
    const matched = lanesForFile(file, manifestIconsOnly);
    for (const lane of matched) lanes[lane] = true;
  }

  return lanes;
}

function lanesForFile(file, manifestIconsOnly) {
  if (isDocumentationOnly(file)) return [];

  if (
    /^web-app\/public\/(?:favicon(?:-[a-z0-9-]+)?|apple-touch-icon(?:-[a-z0-9-]+)?|lixray-icon-[a-z0-9-]+)\.(?:png|svg)$/.test(file) ||
    file === "web-app/src/pwa-icons.json" ||
    (file === "web-app/public/manifest.webmanifest" && manifestIconsOnly)
  ) return ["deploy"];

  // Static public pages have no repository/backend behavior. Reuse fast source
  // checks without preparing the SDK, building images, or running browsers.
  if (isPresentationOnly(file)) return ["fast", "deploy"];

  // Selection and aggregation changes are covered by executable tooling tests.
  // Shared build actions still exercise every lane.
  if (file === ".github/workflows/pr.yml" ||
      /^\.github\/scripts\/(?:classify-ci-changes|check-ci-results)(?:\.test)?\.mjs$/.test(file) ||
      file === ".github/scripts/ci-workflow.test.mjs") return ["tooling"];
  if (file.startsWith(".github/actions/")) return ALL_LANES;
  if ([".github/workflows/production-canary.yml", ".github/workflows/movie-benchmark.yml"].includes(file)) return ["tooling"];
  if (file === ".github/scripts/test-database.sh") return ["database", "e2e", "deploy", "tooling"];
  if (file.startsWith(".github/")) return ALL_LANES.filter((lane) => lane !== "database");

  if (file.startsWith("database/")) return ["database", "e2e", "deploy"];
  if (file === "web-app/package.json" || file === "web-app/Dockerfile" || file.startsWith("web-app/scripts/")) {
    return ["frontend", "e2e", "deploy", "tooling"];
  }
  if (file.startsWith("web-app/")) return ["frontend", "e2e", "deploy"];
  if (file.startsWith("scripts/")) return ["frontend", "e2e", "deploy", "tooling"];
  if (file.startsWith("perf/")) return ["tooling"];

  if (file === "vendor/lix") {
    return ["frontend", "e2e", "deploy", "tooling"];
  }
  if (file === "vendor/atelier") return ["frontend", "e2e", "deploy", "tooling"];

  if (file === "pnpm-lock.yaml") return ALL_LANES.filter((lane) => lane !== "database");

  if (
    [
      ".dockerignore",
      ".gitmodules",
      ".infisical.json",
      "compose.yml",
      "package.json",
      "pnpm-workspace.yaml",
      "railway.json",
    ].includes(file)
  ) {
    return ALL_LANES;
  }

  // New top-level components and unfamiliar configuration run everything until
  // they are deliberately assigned above. False positives cost time; false
  // negatives can merge broken code.
  return ALL_LANES;
}

function isPresentationOnly(file) {
  return [
    "web-app/src/components/landing-page.tsx",
    "web-app/src/components/vs-github-page.tsx",
    "web-app/src/components/docs-page.tsx",
    "web-app/src/components/legal-page.tsx",
    "web-app/src/lib/docs-content.ts",
    "web-app/src/lib/docs-markdown.ts",
    "web-app/src/lib/docs-legal.test.ts",
    "web-app/src/routes/docs.$slug.tsx",
    "web-app/src/routes/docs.index.tsx",
    "web-app/src/routes/lp.lixray-vs-github.tsx",
    "web-app/src/routes/privacy.tsx",
    "web-app/src/routes/terms.tsx",
    "web-app/src/routes/support.tsx",
  ].includes(file) ||
    /^web-app\/src\/.*\.css$/.test(file) ||
    /^web-app\/public\/landing\/.*\.(?:svg|png|jpg|jpeg|webp|avif)$/.test(file);
}

function isDocumentationOnly(file) {
  if (file.startsWith("docs/")) return true;
  if (file.startsWith("reports/")) return true;
  if (/^handbook\/.*\.md$/.test(file)) return true;
  if (!file.includes("/") && file.endsWith(".md")) return true;
  return /^perf\/[^/]+\.md$/.test(file);
}

export function onlyManifestIconsChanged(base, head) {
  try {
    const read = (ref) => {
      const manifest = JSON.parse(execFileSync("git", ["show", `${ref}:web-app/public/manifest.webmanifest`], { encoding: "utf8" }));
      delete manifest.icons;
      return manifest;
    };
    return JSON.stringify(read(base)) === JSON.stringify(read(head));
  } catch {
    // Missing or malformed manifests must not enter the icons-only lane.
    return false;
  }
}

async function main() {
  const base = process.argv[2] ?? "HEAD^1";
  const head = process.argv[3] ?? "HEAD";
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", base, head],
    { encoding: "utf8" },
  );
  const files = output.split("\0").filter(Boolean);
  const lanes = classifyCiChanges(files, {
    manifestIconsOnly: onlyManifestIconsChanged(base, head),
  });
  const lines = Object.entries(lanes).map(([lane, enabled]) => `${lane}=${enabled}`);

  console.log(`Changed files:\n${files.map((file) => `- ${file}`).join("\n")}`);
  console.log(`Selected lanes: ${lines.join(", ")}`);

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  } else {
    console.log(lines.join("\n"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
