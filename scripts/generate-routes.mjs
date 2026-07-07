import { Generator, getConfig } from "@tanstack/router-generator";

const root = process.cwd();
const config = getConfig(
	{
		target: "react",
		routesDirectory: "./src/routes",
		generatedRouteTree: "./src/routeTree.gen.ts",
		disableLogging: true,
		routeTreeFileFooter: [
			`import type { getRouter } from './router.tsx'
import type { startInstance } from './start.ts'
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
    config: Awaited<ReturnType<typeof startInstance.getOptions>>
  }
}`,
		],
	},
	root,
);

await new Generator({ config, root }).run();
