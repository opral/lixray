import { DurableObject } from "cloudflare:workers";

interface Env {
	SIGNAL_TARGET: DurableObjectNamespace<SignalTarget>;
}

export class SignalTarget extends DurableObject {
	signalState(aborted: boolean): { aborted: boolean } {
		return { aborted };
	}
}

export default {
	async fetch(request, env) {
		const state = await env.SIGNAL_TARGET.getByName("test").signalState(
			request.signal.aborted,
		);
		return Response.json({
			isAbortSignal: request.signal instanceof AbortSignal,
			aborted: state.aborted,
		});
	},
} satisfies ExportedHandler<Env>;
