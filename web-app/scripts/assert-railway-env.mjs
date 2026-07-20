const forbiddenDemoVariables = [
	"LIXRAY_DEMO",
	"LIXRAY_DEMO_WORKSPACE_IDS",
	"VITE_LIXRAY_DEMO",
];

const configuredDemoVariables = forbiddenDemoVariables.filter((name) =>
	process.env[name]?.trim(),
);

if (configuredDemoVariables.length > 0) {
	throw new Error(
		`Demo configuration is not supported by the Railway runtime: ${configuredDemoVariables.join(", ")}`,
	);
}
