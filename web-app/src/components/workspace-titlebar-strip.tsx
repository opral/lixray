/**
 * The installed app's title bar over an Atelier workspace: an empty canvas
 * strip as tall as the window-controls area, rendered only in
 * window-controls-overlay mode (styles.css sizes it and makes it drag the
 * window). Place it first in a flex column above the workspace.
 *
 * The workspace has no full-width bar of its own — the sidebar and the main
 * island each start with a header — so without it the macOS traffic lights
 * sat over the sidebar's logo and Chrome's controls over the island's
 * trailing actions. Chrome also paints every controls region in one theme
 * colour, and the left ones sat on the grey canvas while the right ones sat
 * on the white island: no single colour matched both. On this strip both sit
 * on canvas.
 */
export function WorkspaceTitlebarStrip() {
	return (
		<div
			aria-hidden="true"
			data-app-titlebar
			data-workspace-titlebar
			className="shrink-0 bg-bg"
		/>
	);
}
