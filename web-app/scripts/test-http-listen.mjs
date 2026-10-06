import { randomInt } from "node:crypto";

// Node Fetch rejects some valid OS-assigned ports, including 6000. Keep
// test servers in a Fetch-safe range and retry occupied ports finitely.
export async function listenOnFetchSafePort(server) {
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			await new Promise((resolve, reject) => {
				const cleanup = () => {
					server.off("error", onError);
					server.off("listening", onListening);
				};
				const onError = (error) => {
					cleanup();
					reject(error);
				};
				const onListening = () => {
					cleanup();
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(randomInt(50000, 60000), "127.0.0.1");
			});
			return;
		} catch (error) {
			if (error.code !== "EADDRINUSE") throw error;
		}
	}
	throw new Error("Could not bind a Fetch-safe test port.");
}
