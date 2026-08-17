/**
 * Shared visual identity for repositories: the tile palettes and initials
 * used by the directory tiles and the workspace repository picker, so a
 * repository keeps the same chip everywhere.
 */

export interface RepositoryPalette {
	background: string;
	border: string;
	color: string;
}

export const TILE_PALETTES: readonly RepositoryPalette[] = [
	{
		background: "var(--color-bg-selection-current)",
		border: "var(--color-border-selection-current)",
		color: "var(--color-icon-selection-current)",
	},
	{ background: "#eff2e9", border: "#dce3cc", color: "#5a7052" },
	{ background: "#ebf0f4", border: "#d3dfe8", color: "#4a6b85" },
	{ background: "#f3eef6", border: "#e2d7e9", color: "#7a5e8c" },
] as const;

export function repositoryPalette(index: number): RepositoryPalette {
	return TILE_PALETTES[index % TILE_PALETTES.length] ?? TILE_PALETTES[0];
}

export function repositoryInitials(name: string): string {
	const parts = name.match(/[a-z0-9]+/gi) ?? [];
	if (parts.length === 0) return "W";
	const first = parts[0] ?? "W";
	if (parts.length === 1) return first.slice(0, 2).toUpperCase();
	return `${first.charAt(0)}${(parts[1] ?? "").charAt(0)}`.toUpperCase();
}
