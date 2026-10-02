import { createRoot } from "react-dom/client";
import { PublishedResourceView } from "../../src/components/published-resource-view";
import { parseEntityUrlSplat } from "../../src/lib/entity-url";
import "@opral/atelier/style.css";
import "./fixture.css";
const linked =
	parseEntityUrlSplat(location.pathname.split("/file/")[1])?.id ===
	"55555555-5555-4555-8555-555555555555";
createRoot(document.getElementById("root")!).render(
	<PublishedResourceView
		repositoryId="11111111-1111-4111-8111-111111111111"
		namespace="opral"
		repositorySlug="fixture"
		repositoryName="Fixture"
		resource={{
			id: linked
				? "55555555-5555-4555-8555-555555555555"
				: "22222222-2222-4222-8222-222222222222",
			path: linked ? "/next.md" : "/public.md",
			kind: "file",
		}}
	/>,
);

// Exposes the real client to this integration fixture only, so the test can
// verify the data boundary beyond what the renderer happens to request.
import { openPublishedLix } from "../../src/lib/published-lix";
Object.assign(window, {
	async inspectPublishedFiles() {
		const lix = await openPublishedLix({
			origin: location.origin,
			repositoryId: "11111111-1111-4111-8111-111111111111",
			namespace: "opral",
			repositorySlug: "fixture",
			fileId: "22222222-2222-4222-8222-222222222222",
			path: "/public.md",
		});
		try {
			const rows = (
				await lix.execute(
					"SELECT id, path, content FROM lix_file ORDER BY path",
				)
			).rows;
			// Changes here affect only this disposable browser instance.
			await lix.execute("DELETE FROM lix_file WHERE path = $1", ["/public.md"]);
			return { rows };
		} finally {
			await lix.close();
		}
	},
});
