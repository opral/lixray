import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "../..");

export function validateImage(bytes, path, sizes) {
  if (path.endsWith(".svg")) {
    assert.match(bytes.toString(), /<svg\b/, `${path}: expected SVG`);
    return;
  }
  assert.ok(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), `${path}: expected PNG`);
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR", `${path}: missing PNG dimensions`);
  const actual = `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
  if (sizes) assert.equal(actual, sizes, `${path}: incorrect dimensions`);
}

export async function checkPwaAssets({ root = repositoryRoot, baseUrl } = {}) {
  const publicRoot = resolve(root, "web-app/public");
  const links = JSON.parse(await readFile(resolve(root, "web-app/src/pwa-icons.json"), "utf8"));
  assert.ok(Array.isArray(links) && links.length > 0, "PWA links must be a nonempty array");
  const manifestPath = "/manifest.webmanifest";
  assert.equal(links.filter((link) => link.rel === "manifest").length, 1);
  for (const link of links) {
    assert.ok(["icon", "apple-touch-icon", "manifest"].includes(link.rel), "Only PWA links are allowed");
    assert.ok(Object.keys(link).every((key) => ["rel", "href", "type", "sizes"].includes(key)), "Unexpected PWA link property");
    if (link.rel === "manifest") assert.equal(link.href, manifestPath);
  }
  const manifest = JSON.parse(await readFile(resolve(publicRoot, manifestPath.slice(1)), "utf8"));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, "Manifest must declare icons");
  const icons = [
    ...links.filter((link) => link.rel !== "manifest").map((link) => ({ src: link.href, sizes: link.sizes })),
    ...manifest.icons,
  ];
  for (const icon of icons) {
    assert.match(icon.src, /^\/[a-zA-Z0-9_-]+\.(png|svg)$/, "Icons must reference a root public image");
    const bytes = await readFile(resolve(publicRoot, icon.src.slice(1)));
    validateImage(bytes, icon.src, icon.sizes);
  }
  if (baseUrl) {
    const fetchAsset = async (path) => {
      const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(20_000) });
      assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
      return response;
    };
    const deployedManifest = await (await fetchAsset(manifestPath)).json();
    assert.deepEqual(deployedManifest, manifest, "Preview must serve this revision's manifest");
    for (const icon of icons) {
      const response = await fetchAsset(icon.src);
      assert.match(response.headers.get("content-type") ?? "", /^image\//, `${icon.src}: incorrect MIME type`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(bytes, await readFile(resolve(publicRoot, icon.src.slice(1))), `${icon.src}: preview serves different artwork`);
      validateImage(bytes, icon.src, icon.sizes);
    }
    const html = await (await fetchAsset("/")).text();
    for (const link of links) assert.ok(html.includes(`href="${link.href}"`), `Missing deployed link ${link.href}`);
  }
  console.log(`Validated ${icons.length} PWA image references${baseUrl ? " against preview" : ""}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkPwaAssets({ baseUrl: process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : undefined });
}
