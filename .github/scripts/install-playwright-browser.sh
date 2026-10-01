#!/usr/bin/env bash
set -euo pipefail

playwright_chromium_preflight() {
  pnpm --dir web-app exec node --input-type=module -e '
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto("about:blank");
} finally {
  await browser.close();
}
'
}

# Download the pinned Playwright browser first. Ubuntu runners often already
# include the shared libraries Chromium needs; avoid an apt refresh when it runs.
pnpm --dir web-app exec playwright install chromium

if playwright_chromium_preflight; then
  echo "Playwright Chromium launch preflight passed; no system packages needed."
  exit 0
fi

echo "Playwright Chromium launch preflight failed; installing browser dependencies."

# The Azure Ubuntu mirror stalled CI at 31 kB/s and exhausted a browser job's
# budget. On fallback, use the standard mirror for the same signed sources.
for apt_source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  if [[ -f "$apt_source" ]]; then
    sudo sed -i 's|azure.archive.ubuntu.com/ubuntu|archive.ubuntu.com/ubuntu|g' "$apt_source"
  fi
done

pnpm --dir web-app exec playwright install --with-deps chromium
playwright_chromium_preflight
