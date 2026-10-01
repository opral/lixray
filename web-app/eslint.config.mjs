// @ts-check

import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const browserLikeGlobals = {
	...globals.browser,
	...globals.serviceworker,
	...globals.node,
};

export default tseslint.config(
	{
		ignores: [
			"dist/**",
			".architecture/**",
			"node_modules/**",
			"vendor/atelier/**",
			".output/**",
			"target/**",
			"submodule/**",
			"playwright-report/**",
			"test-results/**",
			"src/routeTree.gen.ts",
		],
	},
	{
		files: ["**/*.{js,mjs,cjs}"],
		extends: [js.configs.recommended, prettierConfig],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: browserLikeGlobals,
		},
	},
	{
		files: ["**/*.{ts,tsx,mts,cts}"],
		extends: [
			js.configs.recommended,
			...tseslint.configs.recommendedTypeChecked,
			reactHooks.configs.flat.recommended,
			prettierConfig,
		],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: browserLikeGlobals,
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"playwright.config.ts",
						"playwright.performance.config.ts",
						"src/worker/*.test.ts",
					],
					maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 32,
					defaultProject: "tsconfig.eslint.json",
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unnecessary-type-assertion": "off",
			"react-hooks/exhaustive-deps": "error",
			"react-hooks/set-state-in-effect": "off",
		},
	},
	{
		files: ["**/*.test.ts", "tests/**/*.{ts,tsx}"],
		rules: {
			"@typescript-eslint/require-await": "off",
		},
	},
);
