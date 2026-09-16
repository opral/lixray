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
		background: "var(--atelier-accent-subtle)",
		border: "var(--atelier-accent-border)",
		color: "var(--atelier-accent)",
	},
	{
		background: "var(--atelier-tag-green)",
		border:
			"color-mix(in srgb, var(--atelier-tag-green-fg) 20%, var(--atelier-tag-green))",
		color: "var(--atelier-tag-green-fg)",
	},
	{
		background: "var(--atelier-tag-blue)",
		border: "color-mix(in srgb, var(--atelier-tag-blue-fg) 20%, var(--atelier-tag-blue))",
		color: "var(--atelier-tag-blue-fg)",
	},
	{
		background: "var(--atelier-tag-purple)",
		border:
			"color-mix(in srgb, var(--atelier-tag-purple-fg) 20%, var(--atelier-tag-purple))",
		color: "var(--atelier-tag-purple-fg)",
	},
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
