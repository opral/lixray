import { readdirSync, readFileSync } from "node:fs";

const corpus = new URL("../data/raw/scored/current-compact/", import.meta.url);
let executeCalls = 0;
let cells = 0;
let taggedChars = 0;
let primitiveChars = 0;

for (const file of readdirSync(corpus).filter((name) =>
	name.endsWith(".jsonl"),
)) {
	const transcript = readFileSync(new URL(file, corpus), "utf8");
	for (const line of transcript.split("\n")) {
		if (!line) continue;
		const event = JSON.parse(line);
		const item = event.item;
		const results = item?.result?.structured_content?.results;
		if (
			event.type !== "item.completed" ||
			item?.type !== "mcp_tool_call" ||
			item.tool !== "execute" ||
			!results
		) {
			continue;
		}

		executeCalls += 1;
		taggedChars += JSON.stringify({ results }).length;
		const primitiveResults = results.map((result) => ({
			...result,
			rows: result.rows.map((row) =>
				row.map((cell) => {
					cells += 1;
					return cell.kind === "blob" || cell.kind === "json"
						? cell
						: cell.value;
				}),
			),
		}));
		primitiveChars += JSON.stringify({ results: primitiveResults }).length;
	}
}

const reductionChars = taggedChars - primitiveChars;
console.log(
	JSON.stringify(
		{
			executeCalls,
			cells,
			taggedChars,
			primitiveChars,
			reductionChars,
			reductionPercent: Number(
				((100 * reductionChars) / taggedChars).toFixed(1),
			),
		},
		null,
		2,
	),
);
