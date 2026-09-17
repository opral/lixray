import type { BrowserContext, Page } from "@playwright/test";

/** Read-only RPC probes on the existing session; no second engine or storage open. */
export async function installSyncDiagnostics(context: BrowserContext) {
	await context.addInitScript(() => {
		if (typeof SharedWorker === "undefined") return;
		const ports: MessagePort[] = [];
		const Original = SharedWorker;
		globalThis.SharedWorker = new Proxy(Original, {
			construct(target, args: ConstructorParameters<typeof SharedWorker>) {
				const worker = new target(...args);
				ports.push(worker.port);
				return worker;
			},
		});
		let nextId = -1;
		const request = (port: MessagePort, operation: Record<string, unknown>) =>
			new Promise<unknown>((resolve) => {
				const id = nextId--;
				const finish = (value: unknown) => {
					clearTimeout(timer);
					port.removeEventListener("message", listener);
					resolve(value);
				};
				const listener = (
					event: MessageEvent<{
						id?: number;
						ok?: boolean;
						value?: unknown;
						error?: unknown;
					}>,
				) => {
					if (event.data.id === id)
						finish(
							event.data.ok ? event.data.value : { error: event.data.error },
						);
				};
				const timer = setTimeout(
					() => finish({ error: "diagnostic RPC exceeded 5 seconds" }),
					5000,
				);
				port.addEventListener("message", listener);
				port.postMessage({ id, sessionId: 0, operation });
			});
		Object.assign(globalThis, {
			__lixSyncDiagnostic: async (path: string) => {
				const port = ports.at(-1);
				if (!port) return { error: "No shared worker session" };
				const [health, rows] = await Promise.all([
					request(port, { kind: "syncHealth" }),
					request(port, {
						kind: "execute",
						sql: "SELECT id, path, content FROM lix_file WHERE path = $1",
						params: [{ kind: "text", value: path }],
					}),
				]);
				return { health, rows };
			},
		});
	});
}

export async function collectSyncDiagnostics(page: Page) {
	return page.evaluate(async () => {
		const tail = location.pathname.split("/file/")[1];
		const path = tail
			? "/" + tail.split("/").slice(1).map(decodeURIComponent).join("/")
			: "";
		const probe = (
			globalThis as typeof globalThis & {
				__lixSyncDiagnostic?: (path: string) => Promise<unknown>;
			}
		).__lixSyncDiagnostic;
		return {
			url: location.href,
			path,
			editor: Array.from(
				document.querySelectorAll('.ProseMirror[contenteditable="true"]'),
			).map((element) => (element as HTMLElement).innerText),
			local: probe
				? await probe(path)
				: { error: "Diagnostic hook unavailable" },
		};
	});
}
