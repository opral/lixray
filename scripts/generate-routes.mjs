import { Generator, getConfig } from "@tanstack/router-generator";

const root = process.cwd();
const config = getConfig(
	{
		target: "react",
		routesDirectory: "./src/routes",
		generatedRouteTree: "./src/routeTree.gen.ts",
		quoteStyle: "double",
		semicolons: true,
		disableLogging: true,
	},
	root,
);

await new Generator({ config, root }).run();
