import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkPwaAssets, validateImage } from "./check-pwa-assets.mjs";

test("validates current PWA references", async () => { await checkPwaAssets(); });

test("rejects corrupt images and incorrect advertised sizes", () => {
  assert.throws(() => validateImage(Buffer.from("not PNG"), "/icon.png"), /expected PNG/);
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12); bytes.writeUInt32BE(192, 16); bytes.writeUInt32BE(192, 20);
  assert.throws(() => validateImage(bytes, "/icon.png", "512x512"), /incorrect dimensions/);
});

test("metadata cannot add a stylesheet to the assets-only lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "pwa-check-"));
  try {
    await mkdir(join(root, "web-app/src"), { recursive: true });
    await writeFile(join(root, "web-app/src/pwa-icons.json"), JSON.stringify([
      { rel: "manifest", href: "/manifest.webmanifest" }, { rel: "stylesheet", href: "/app.css" },
    ]));
    await assert.rejects(checkPwaAssets({ root }), /Only PWA links/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
