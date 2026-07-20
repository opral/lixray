const forbiddenDemoVariables = [
	"LIXRAY_DEMO",
	"LIXRAY_DEMO_WORKSPACE_IDS",
	"VITE_LIXRAY_DEMO",
];

const configuredDemoVariables = forbiddenDemoVariables.filter((name) =>
	process.env[name]?.trim(),
);

const isPullRequestEnvironment = /^lixray-pr-\d+$/.test(
	process.env.RAILWAY_ENVIRONMENT_NAME ?? "",
);

if (configuredDemoVariables.length > 0 && !isPullRequestEnvironment) {
	throw new Error(
		`Demo configuration is only supported in Railway PR environments: ${configuredDemoVariables.join(", ")}`,
	);
}
