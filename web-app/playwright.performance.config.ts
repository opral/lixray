import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Explicit performance run; never included by the correctness *.spec.ts glob.
export default defineConfig({ ...base, testMatch: "*.perf.ts", workers: 1 });
