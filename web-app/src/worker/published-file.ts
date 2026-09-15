import { openLix, type Lix } from "@lix-js/sdk";

/** The caller authorizes the exact path before opening this server-owned client. */
export async function downloadPublishedFile(options: {
	lixId: string;
	id: string;
	path: string;
	signal: AbortSignal;
	lixFetch: (lixId: string, request: Request) => Promise<Response>;
}): Promise<Response> {
	let lix: Lix | undefined;
	let failureStatus: number | undefined;
	try {
		options.signal.throwIfAborted();
		lix = await openLix({
			server: {
				mode: "remote",
				url: `https://published.lixray.invalid/lix/${options.lixId}`,
				headers: {
					"X-Lixray-Idempotency-Principal":
						"00000000-0000-7000-8000-000000000002",
				},
				fetch: async (input, init) => {
					const request = new Request(input, init);
					const response = await options.lixFetch(
						options.lixId,
						new Request(request, {
							signal:
								request.method === "DELETE"
									? request.signal
									: AbortSignal.any([request.signal, options.signal]),
						}),
					);
					if (!response.ok && request.method !== "DELETE")
						failureStatus = response.status;
					return response;
				},
			},
		});
		const result = await lix.execute(
			"SELECT content FROM lix_file WHERE id = $1 AND path = $2",
			[options.id, options.path],
		);
		const content = result.rows[0]?.content;
		if (!result.rows.length)
			return new Response("File not found", { status: 404 });
		if (!(content instanceof Uint8Array))
			throw new Error("Unexpected file content");
		return new Response(new Uint8Array(content), {
			headers: {
				"content-type": "application/octet-stream",
				"content-disposition": "attachment",
				"x-content-type-options": "nosniff",
				"cache-control": "no-store",
			},
		});
	} catch {
		// Authorization was checked before opening. Upstream credentials/session
		// errors indicate a service failure, not a change in publication status.
		return Response.json(
			{
				error: {
					code:
						failureStatus === 426
							? "LIX_PROTOCOL_VERSION_MISMATCH"
							: "PUBLISHED_FILE_UNAVAILABLE",
				},
			},
			{
				status: failureStatus === 426 ? 426 : 502,
				headers: { "cache-control": "no-store" },
			},
		);
	} finally {
		await lix?.close().catch(() => undefined);
	}
}
