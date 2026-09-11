import { useEffect } from "react";
import { installThemeColorSync } from "~/lib/theme-color-sync";

/**
 * Keeps the PWA window-controls colour equal to what the page paints behind
 * them: dialog backdrops, the review glow, any future overlay. See
 * `~/lib/theme-color-sync`.
 */
export function ThemeColorSync() {
	useEffect(() => installThemeColorSync(), []);
	return null;
}
