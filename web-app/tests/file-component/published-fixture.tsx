import { createRoot } from "react-dom/client";
import { PublishedResourceView } from "../../src/components/published-resource-view";
import "./fixture.css";
createRoot(document.getElementById("root")!).render(
	<PublishedResourceView
		repositoryId="11111111-1111-4111-8111-111111111111"
		namespace="opral"
		repositorySlug="fixture"
		repositoryName="Fixture"
		resource={{
			id: "22222222-2222-4222-8222-222222222222",
			path: "/public.md",
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
