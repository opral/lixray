import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ALL_LANES = ["frontend", "database", "e2e"];

export function classifyCiChanges(files) {
  const lanes = Object.fromEntries(ALL_LANES.map((lane) => [lane, false]));

  for (const file of files) {
    const matched = lanesForFile(file);
    for (const lane of matched) lanes[lane] = true;
  }

  return lanes;
}

function lanesForFile(file) {
  if (isDocumentationOnly(file)) return [];

  // CI infrastructure changes exercise every lane so changes to the classifier,
  // shared actions, and workflows cannot silently skip their own validation.
  if (file.startsWith(".github/")) return ALL_LANES;

  if (file.startsWith("database/")) return ["database", "e2e"];
  if (file.startsWith("web-app/")) return ["frontend", "e2e"];
  if (file.startsWith("scripts/")) return ["frontend", "e2e"];
  if (file.startsWith("perf/")) return ["frontend"];

  if (file === "vendor/lix") {
    return ["frontend", "e2e"];
  }
  if (file === "vendor/atelier") return ["frontend", "e2e"];

  if (
    [
      ".dockerignore",
      ".gitmodules",
      ".infisical.json",
      "compose.yml",
      "package.json",
      "pnpm-lock.yaml",
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

function isDocumentationOnly(file) {
  if (file.startsWith("docs/")) return true;
  if (file.startsWith("reports/")) return true;
  if (!file.includes("/") && file.endsWith(".md")) return true;
  return /^perf\/[^/]+\.md$/.test(file);
}

async function main() {
  const base = process.argv[2] ?? "HEAD^1";
  const head = process.argv[3] ?? "HEAD";
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", base, head],
    { encoding: "utf8" },
  );
  const files = output.split("\0").filter(Boolean);
  const lanes = classifyCiChanges(files);
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
