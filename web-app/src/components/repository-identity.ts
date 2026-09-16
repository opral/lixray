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
		background: "var(--at-accent-subtle)",
		border: "var(--at-accent-border)",
		color: "var(--at-accent)",
	},
	{
		background: "var(--at-tag-green)",
		border:
			"color-mix(in srgb, var(--at-tag-green-fg) 20%, var(--at-tag-green))",
		color: "var(--at-tag-green-fg)",
	},
	{
		background: "var(--at-tag-blue)",
		border: "color-mix(in srgb, var(--at-tag-blue-fg) 20%, var(--at-tag-blue))",
		color: "var(--at-tag-blue-fg)",
	},
	{
		background: "var(--at-tag-purple)",
		border:
			"color-mix(in srgb, var(--at-tag-purple-fg) 20%, var(--at-tag-purple))",
		color: "var(--at-tag-purple-fg)",
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
