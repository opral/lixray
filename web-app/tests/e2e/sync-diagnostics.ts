import type { BrowserContext, Page } from "@playwright/test";

/** Read-only RPC probes on the existing session; no second engine or storage open. */
export async function installSyncDiagnostics(context: BrowserContext) {
	await context.addInitScript(() => {
		if (typeof SharedWorker === "undefined") return;
		const ports: MessagePort[] = [];
		const observerFrames: unknown[] = [];
		const record = (value: unknown) => {
			let budget = 32768;
			const bounded = (item: unknown, depth = 0): unknown => {
				if (budget <= 0 || depth > 12) return "[clipped]";
				if (typeof item === "string") {
					const text = item.slice(0, Math.min(8192, budget));
					budget -= text.length;
					return text;
				}
				if (item instanceof Uint8Array)
					return bounded(
						{
							bytes: item.byteLength,
							text: new TextDecoder().decode(item.subarray(0, 8192)),
						},
						depth + 1,
					);
				if (Array.isArray(item))
					return item
						.slice(0, 64)
						.map((entry: unknown) => bounded(entry, depth + 1));
				if (item && typeof item === "object")
					return Object.fromEntries(
						Object.entries(item)
							.slice(0, 32)
							.map(([key, entry]) => {
								budget -= key.length + 8;
								return [key, bounded(entry, depth + 1)];
							}),
					);
				budget -= 8;
				return item;
			};
			observerFrames.push(bounded(value));
			if (observerFrames.length > 100) observerFrames.shift();
		};
		const Original = SharedWorker;
		globalThis.SharedWorker = new Proxy(Original, {
			construct(target, args: ConstructorParameters<typeof SharedWorker>) {
				const worker = new target(...args);
				ports.push(worker.port);
				const requests = new Map<number, unknown>();
				const post = worker.port.postMessage.bind(worker.port);
				worker.port.postMessage = function (
					...args: Parameters<MessagePort["postMessage"]>
				) {
					const message = args[0] as {
						id?: number;
						operation?: { kind?: string };
					} | null;
					if (
						message &&
						typeof message.operation?.kind === "string" &&
						message.operation.kind.startsWith("observe") &&
						typeof message.id === "number"
					) {
						requests.set(message.id, message.operation);
						if (requests.size > 200)
							requests.delete(requests.keys().next().value!);
					}
					Reflect.apply(post, this, args);
				};
				worker.port.addEventListener(
					"message",
					(event: MessageEvent<{ id?: number }>) => {
						if (
							typeof event.data?.id !== "number" ||
							!requests.has(event.data.id)
						)
							return;
						const operation = requests.get(event.data.id);
						requests.delete(event.data.id);
						record({ operation, response: event.data });
					},
				);
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
				return { health, rows, observerFrames };
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
		const sources: unknown[] = [];
		for (const element of document.querySelectorAll(".ProseMirror")) {
			let host: Element | null = element;
			let key: string | undefined;
			for (
				let depth = 0;
				host && depth < 30;
				depth++, host = host.parentElement
			) {
				key = Object.keys(host).find((key) => key.startsWith("__reactFiber$"));
				if (key) break;
			}
			if (!key || !host) continue;
			type Fiber = {
				return?: Fiber;
				alternate?: Fiber;
				memoizedState?: { memoizedState?: unknown; next?: unknown };
				memoizedProps?: Record<string, unknown>;
			};
			let fiber = (host as unknown as Record<string, Fiber>)[key];
			for (let depth = 0; fiber && depth < 60; depth++, fiber = fiber.return!) {
				for (const node of [fiber, fiber.alternate]) {
					let hook = node?.memoizedState;
					for (
						let index = 0;
						hook && index < 100;
						index++, hook = hook.next as typeof hook
					) {
						const state = hook.memoizedState;
						const value: unknown = Array.isArray(state) ? state[0] : null;
						if (
							value &&
							typeof value === "object" &&
							"pendingExternalMarkdown" in value &&
							"sawInitialSnapshot" in value
						) {
							sources.push({
								depth,
								alternate: node !== fiber,
								pendingExternalMarkdown: value.pendingExternalMarkdown,
								sawInitialSnapshot: value.sawInitialSnapshot,
								initialObservedMarkdown:
									"initialObservedMarkdown" in value
										? value.initialObservedMarkdown
										: undefined,
							});
						}
					}
					const props = node?.memoizedProps;
					if (!props || !("sourceFile" in props)) continue;
					const file = props.sourceFile as
						| { content?: Uint8Array; path?: string }
						| undefined;
					sources.push({
						depth,
						alternate: node !== fiber,
						activeFileId: props.activeFileId,
						path: file?.path,
						content: file?.content
							? new TextDecoder().decode(file.content)
							: null,
					});
				}
			}
		}
		return {
			sources,
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
