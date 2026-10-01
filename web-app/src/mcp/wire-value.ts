import { z } from "zod";
import type { ResultColumnType } from "@lix-js/sdk";

/** The SDK's complete value contract, shared by MCP inputs and outputs. */
const schemas = {
	null: z
		.object({ kind: z.literal("null"), value: z.null().optional() })
		.strict(),
	boolean: z.object({ kind: z.literal("bool"), value: z.boolean() }).strict(),
	integer: z
		.object({ kind: z.literal("int"), value: z.number().int() })
		.strict(),
	real: z.object({ kind: z.literal("float"), value: z.number() }).strict(),
	text: z.object({ kind: z.literal("text"), value: z.string() }).strict(),
	timestamptz: z
		.object({ kind: z.literal("timestamp"), value: z.string() })
		.strict(),
	row_ref: z
		.object({
			kind: z.literal("row_ref"),
			value: z.string().regex(/^lix_row_ref:v2:[^\s]+$/),
		})
		.strict(),
	blob: z.object({ kind: z.literal("blob"), base64: z.string() }).strict(),
	jsonb: z.object({ kind: z.literal("json"), value: z.unknown() }).strict(),
} satisfies Record<ResultColumnType, z.ZodType>;

const values = Object.values(schemas);
export const wireValue = z.union(
	values as [
		(typeof values)[number],
		(typeof values)[number],
		...(typeof values)[number][],
	],
);
export type WireValue = z.infer<typeof wireValue>;

export function unreachableValue(value: never): never {
	throw new Error(`Unsupported SDK value type: ${String(value)}`);
}
