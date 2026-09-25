/** SQL for the commit-pinned file changes shown by diff and write receipts. */
export const FILE_CHANGES_SQL = (count: number): string => {
	const select =
		"SELECT id, diff_type, from_path, to_path, from_content, to_content FROM lix_diff('lix_file', $1, $2)";
	if (count === 0) return select;
	const placeholders = Array.from(
		{ length: count },
		(_, index) => `$${index + 3}`,
	).join(", ");
	return `${select} WHERE from_path IN (${placeholders}) OR to_path IN (${placeholders})`;
};
