import type { BrowserContext, Page } from "@playwright/test";

/** Read-only RPC probes on the existing session; no second engine or storage open. */
export async function installSyncDiagnostics(context: BrowserContext) {
	await context.addInitScript(() => {
		type DiagnosticPort = {
			postMessage(message: unknown): void;
			addEventListener(
				type: "message",
				listener: (event: MessageEvent) => void,
			): void;
			removeEventListener(
				type: "message",
				listener: (event: MessageEvent) => void,
			): void;
		};
		const ports: DiagnosticPort[] = [];
		// Current SDKs route the elected dedicated worker through BroadcastChannel.
		// Reuse the application's client envelope for read-only probes.
		const OriginalChannel = BroadcastChannel;
		globalThis.BroadcastChannel = new Proxy(OriginalChannel, {
			construct(target, args: ConstructorParameters<typeof BroadcastChannel>) {
				const channel = new target(...args);
				if (!args[0].startsWith("lix:repository-rpc:v1:")) return channel;
				const listeners = new Set<(event: MessageEvent) => void>();
				let envelope: { client: string; generation: string } | undefined;
				const sessions = new Set<number>();
				const post = channel.postMessage.bind(channel);
				channel.postMessage = (raw: unknown) => {
					const message = raw as {
						kind?: string;
						client: string;
						generation: string;
						message?: { sessionId?: number; operation?: { kind?: string } };
					} | null;
					if (message?.kind === "input") {
						envelope = {
							client: message.client,
							generation: message.generation,
						};
						const sessionId = message.message?.sessionId;
						if (typeof sessionId === "number") {
							sessions.delete(sessionId);
							if (message.message?.operation?.kind !== "close")
								sessions.add(sessionId);
						}
					}
					post(raw);
				};
				channel.addEventListener(
					"message",
					(
						event: MessageEvent<{
							kind?: string;
							client?: string;
							message?: unknown;
						}>,
					) => {
						if (
							event.data?.kind !== "output" ||
							event.data.client !== envelope?.client
						)
							return;
						for (const listener of listeners)
							listener(
								new MessageEvent("message", { data: event.data.message }),
							);
					},
				);
				ports.push({
					postMessage: (message) => {
						if (!envelope) throw new Error("Repository client is not ready");
						const sessionId = [...sessions].at(-1);
						if (sessionId === undefined)
							throw new Error("Repository session is not ready");
						post({
							kind: "input",
							...envelope,
							message: { ...(message as object), sessionId },
						});
					},
					addEventListener: (_type, listener) => {
						listeners.add(listener);
					},
					removeEventListener: (_type, listener) => {
						listeners.delete(listener);
					},
				});
				return channel;
			},
		});
		const lifecycle: unknown[] = [];
		const recordLifecycle = (value: unknown) => {
			lifecycle.push(value);
			if (lifecycle.length > 100) lifecycle.shift();
		};
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
					value: unknown,
					transferOrOptions?: Transferable[] | StructuredSerializeOptions,
				) {
					const message = value as {
						id?: number;
						kind?: string;
						sessionId?: number;
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
					if (message)
						recordLifecycle({
							direction: "send",
							at: performance.now(),
							id: message.id,
							sessionId: message.sessionId,
							kind: message.operation?.kind ?? message.kind,
						});
					Reflect.apply(post, this, [value, transferOrOptions]);
				};
				worker.port.addEventListener(
					"message",
					(
						event: MessageEvent<{
							id?: number;
							kind?: string;
							ok?: boolean;
							error?: { code?: string };
						}>,
					) => {
						recordLifecycle({
							direction: "receive",
							at: performance.now(),
							id: event.data?.id,
							kind: event.data?.kind,
							ok: event.data?.ok,
							errorCode: event.data?.error?.code,
						});
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
		const request = (
			port: DiagnosticPort,
			operation: Record<string, unknown>,
		) =>
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
			__lixSyncHead: async () => {
				const port = ports.at(-1);
				if (!port) throw new Error("No repository worker session");
				return request(port, {
					kind: "execute",
					sql: "SELECT lix_active_branch_commit_id() AS commit_id",
					params: [],
				});
			},
			__lixSyncFiles: async () => {
				const port = ports.at(-1);
				if (!port) throw new Error("No repository worker session");
				return request(port, {
					kind: "execute",
					sql: "SELECT id, path FROM lix_file",
					params: [],
				});
			},
			__lixSyncDiagnostic: async (path: string) => {
				const port = ports.at(-1);
				if (!port) return { error: "No repository worker session" };
				const [health, rows] = await Promise.all([
					request(port, { kind: "syncHealth" }),
					request(port, {
						kind: "execute",
						sql: "SELECT id, path, content FROM lix_file WHERE path = $1",
						params: [{ kind: "text", value: path }],
					}),
				]);
				return { health, rows, observerFrames, lifecycle };
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
						| { content?: unknown; path?: string }
						| undefined;
					const content = file?.content;
					sources.push({
						depth,
						alternate: node !== fiber,
						activeFileId: props.activeFileId,
						path: file?.path,
						content:
							typeof content === "string"
								? content
								: content instanceof Uint8Array
									? new TextDecoder().decode(content)
									: null,
					});
				}
			}
		}
		const locks = await navigator.locks.query();
		return {
			locks,
			openMarks: performance
				.getEntriesByType("mark")
				.filter((entry) => entry.name.startsWith("lixray:repository-open:"))
				.map(({ name, startTime }) => ({ name, startTime })),
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
