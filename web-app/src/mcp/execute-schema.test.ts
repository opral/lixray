import assert from "node:assert/strict";
import test from "node:test";
import { openLix } from "@lix-js/sdk";
import {
	EXECUTE_SQL_INTROSPECTION_QUERY,
	EXECUTE_SQL_REFERENCE_DDL,
	EXECUTE_SQL_SURFACES,
	type ExecuteSqlType,
} from "./execute-schema.ts";

void test("execute reference DDL matches a fresh Lix public schema", async (t) => {
	assert.equal(EXECUTE_SQL_SURFACES.length, 48);
	assert.equal(
		EXECUTE_SQL_SURFACES.filter(
			(sqlSurface) => sqlSurface.objectKind === "BASE TABLE",
		).length,
		34,
	);
	assert.equal(
		EXECUTE_SQL_SURFACES.filter(
			(sqlSurface) => sqlSurface.objectKind === "VIEW",
		).length,
		14,
	);

	const lix = await openLix();
	t.after(async () => lix.close());
	const result = await lix.execute(EXECUTE_SQL_INTROSPECTION_QUERY);
	const actual = result.rows.map((row) => row.toObject());
	const expected = [...EXECUTE_SQL_SURFACES]
		.sort((left, right) => left.name.localeCompare(right.name))
		.flatMap((sqlSurface) =>
			sqlSurface.columns.map((sqlColumn, ordinalPosition) => ({
				table_name: sqlSurface.name,
				table_type: sqlSurface.objectKind,
				column_name: sqlColumn.name,
				data_type: dataFusionType(sqlColumn.type),
				is_nullable: sqlColumn.nullable ? "YES" : "NO",
				ordinal_position: ordinalPosition,
			})),
		);

	assert.deepEqual(actual, expected);
});

void test("execute reference DDL enumerates every surface and labels views", () => {
	const declaredNames = Array.from(
		EXECUTE_SQL_REFERENCE_DDL.matchAll(/^CREATE TABLE (\w+) \(/gm),
		(match) => match[1],
	);
	assert.deepEqual(
		declaredNames,
		EXECUTE_SQL_SURFACES.map((sqlSurface) => sqlSurface.name),
	);
	for (const sqlSurface of EXECUTE_SQL_SURFACES) {
		const declaration = `CREATE TABLE ${sqlSurface.name} (`;
		assert.ok(EXECUTE_SQL_REFERENCE_DDL.includes(declaration));
		if (sqlSurface.objectKind === "VIEW") {
			assert.ok(
				EXECUTE_SQL_REFERENCE_DDL.includes(
					`-- Actual object: read-only VIEW.\n${declaration}`,
				),
			);
		}
	}
	assert.doesNotMatch(EXECUTE_SQL_REFERENCE_DDL, /information_schema/);
	assert.match(EXECUTE_SQL_REFERENCE_DDL, /entity_pk JSON NOT NULL/);
	assert.match(EXECUTE_SQL_REFERENCE_DDL, /data BLOB NOT NULL/);
});

function dataFusionType(sqlType: ExecuteSqlType): string {
	switch (sqlType) {
		case "TEXT":
		case "JSON":
			return "Utf8";
		case "BOOLEAN":
			return "Boolean";
		case "BIGINT":
			return "Int64";
		case "BLOB":
			return "LargeBinary";
	}
}
