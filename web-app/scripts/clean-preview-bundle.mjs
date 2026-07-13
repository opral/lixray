import { rm } from "node:fs/promises";

await rm(new URL("../dist/preview-worker", import.meta.url), {
	recursive: true,
	force: true,
});
