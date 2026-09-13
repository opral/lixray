// Delay a real successful candidate receipt read across the migration heartbeat.
// No error is manufactured: the next ordinary OPFS read naturally expires.
export async function createLixStorageProvider(options) {
	const module = await import(/* @vite-ignore */ options.originalModuleUrl);
	const provider = await module.createLixStorageProvider(
		options.originalOptions,
	);
	let delayed = false;
	return new Proxy(provider, {
		get(target, property) {
			if (property === "beginRead")
				return async (...args) => {
					const read = await target.beginRead(...args);
					return new Proxy(read, {
						get(scope, method) {
							if (method === "getMany")
								return async (requests) => {
									const result = await scope.getMany(requests);
									if (
										!delayed &&
										requests.some(
											(request) =>
												request.space.id >= 0x100000 &&
												(request.space.id & 0xfffff) === 0x70014 &&
												request.keys.some(
													(key) =>
														new TextDecoder().decode(key) === "repository",
												),
										)
									) {
										delayed = true;
										const notification = new BroadcastChannel(
											"lixray-migration-qa-delay",
										);
										notification.postMessage(options.originalOptions.name);
										notification.close();
										await new Promise((resolve) => setTimeout(resolve, 1500));
									}
									return result;
								};
							const value = Reflect.get(scope, method);
							return typeof value === "function" ? value.bind(scope) : value;
						},
					});
				};
			const value = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
