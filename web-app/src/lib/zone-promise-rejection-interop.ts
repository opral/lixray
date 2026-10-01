type ZoneLike = {
	__symbol__(name: string): string;
	[key: string]: unknown;
};

type PromiseRejectionTarget = Pick<Window, "dispatchEvent"> & {
	Event?: typeof Event;
	PromiseRejectionEvent?: { prototype: object };
};

type ZoneRejectionEnvelope = {
	rejection?: unknown;
	promise?: unknown;
	zone?: unknown;
};

type ZoneGlobal = typeof globalThis & {
	__Zone_symbol_prefix?: string;
	Zone?: ZoneLike;
};

// Zone's default unwrap mode discards the rejected Promise and source Zone
// before its rejection hook runs. Keep both so we can restore a real event.
if (typeof window !== "undefined" && !(globalThis as ZoneGlobal).Zone) {
	const global = globalThis as ZoneGlobal & Record<string, unknown>;
	const prefix = global.__Zone_symbol_prefix ?? "__zone_symbol__";
	global[`${prefix}DISABLE_WRAPPING_UNCAUGHT_PROMISE_REJECTION`] = false;
}

function zoneApi(): ZoneLike | undefined {
	return (globalThis as ZoneGlobal).Zone;
}

function rejectionEnvelope(value: unknown): ZoneRejectionEnvelope | undefined {
	return typeof value === "object" && value !== null
		? (value as ZoneRejectionEnvelope)
		: undefined;
}

function promiseLike(value: unknown): Promise<unknown> | undefined {
	return value &&
		typeof value === "object" &&
		"then" in value &&
		typeof value.then === "function"
		? (value as Promise<unknown>)
		: undefined;
}

function runnableZone(
	value: unknown,
): { run(callback: () => void): unknown } | undefined {
	return value &&
		typeof value === "object" &&
		"run" in value &&
		typeof value.run === "function"
		? (value as { run(callback: () => void): unknown })
		: undefined;
}

/**
 * Zone.js 0.16.3 invokes EventTarget tasks with the wrong arguments from its
 * PromiseRejectionEvent hook. Re-dispatch through the native event target so
 * registered SDK listeners run through the regular EventTarget path. A plain
 * Event avoids WebIDL Promise conversion, which would assimilate ZoneAwarePromise
 * and create an unrelated native rejection while constructing the event. Reuse
 * the native rejection-event prototype when available so SDKs that check the
 * event type still recognize it; the Event constructor supplies the dispatchable
 * internal slots and the own fields retain the original Promise and reason.
 */
export function installZonePromiseRejectionInterop(
	target: PromiseRejectionTarget,
	zone = zoneApi(),
): boolean {
	if (!zone || typeof zone.__symbol__ !== "function") return false;
	const EventConstructor = target.Event;
	if (!EventConstructor || typeof target.dispatchEvent !== "function")
		return false;

	const markerKey = zone.__symbol__("lixrayPromiseRejectionInterop");
	if (zone[markerKey] === true) return true;
	const unhandledKey = zone.__symbol__("unhandledPromiseRejectionHandler");
	const handledKey = zone.__symbol__("rejectionHandledHandler");
	if (typeof zone[unhandledKey] !== "function") return false;

	const dispatch = (
		type: "unhandledrejection" | "rejectionhandled",
		value: unknown,
	) => {
		const envelope = rejectionEnvelope(value);
		const wrapped =
			envelope &&
			Object.hasOwn(envelope, "rejection") &&
			Object.hasOwn(envelope, "promise");
		if (!wrapped) return;
		const promise = promiseLike(envelope.promise);
		if (!promise) return;
		const rejection = envelope.rejection;
		const rejectionZone = wrapped ? runnableZone(envelope.zone) : undefined;
		try {
			const event = new EventConstructor(type, { cancelable: true });
			Object.defineProperties(event, {
				promise: { value: promise, enumerable: true },
				reason: { value: rejection, enumerable: true },
			});
			const rejectionPrototype = target.PromiseRejectionEvent?.prototype;
			if (rejectionPrototype) Object.setPrototypeOf(event, rejectionPrototype);
			const emit = () => target.dispatchEvent(event);
			if (rejectionZone) rejectionZone.run(emit);
			else emit();
		} catch {
			// A listener must never change the rejected Promise's behavior.
		}
	};

	try {
		zone[unhandledKey] = (error: unknown) =>
			dispatch("unhandledrejection", error);
		if (typeof zone[handledKey] === "function")
			zone[handledKey] = (error: unknown) =>
				dispatch("rejectionhandled", error);
		zone[markerKey] = true;
		return true;
	} catch {
		return false;
	}
}
