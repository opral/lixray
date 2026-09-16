import { createRoot } from "react-dom/client";
import { RepositoryUpgradeProgress } from "../../src/components/repository-upgrade-progress";
createRoot(document.getElementById("root")!).render(
	<RepositoryUpgradeProgress phase="migrating" />,
);
