import { DurableObject } from "cloudflare:workers";

interface Env {
	SIGNAL_TARGET: DurableObjectNamespace<SignalTarget>;
}

export class SignalTarget extends DurableObject {
	signalState(signal: AbortSignal): {
		isAbortSignal: boolean;
		aborted: boolean;
	} {
		return {
			isAbortSignal: signal instanceof AbortSignal,
			aborted: signal.aborted,
		};
	}
}

export default {
	async fetch(request, env) {
		return Response.json(
			await env.SIGNAL_TARGET.getByName("test").signalState(request.signal),
		);
	},
} satisfies ExportedHandler<Env>;
