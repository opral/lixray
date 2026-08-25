import { openLix, type Lix } from "@lix-js/sdk";

type OpenPrewarmLix = () => Promise<Pick<Lix, "close">>;

/**
 * Leaves one initialized Lix worker in the SDK's idle pool without keeping an
 * in-memory repository open.
 */
export function createLixPrewarmer(open: OpenPrewarmLix = openLix) {
	let prewarming: Promise<void> | undefined;

	return {
		prewarmLix: (): Promise<void> => {
			if (!prewarming) {
				prewarming = open()
					.then((lix) => lix.close())
					.catch((error: unknown) => {
						prewarming = undefined;
						throw error;
					});
			}
			return prewarming;
		},
		waitForLixPrewarm: async (): Promise<void> => {
			await prewarming?.catch(() => undefined);
		},
	};
}

export const { prewarmLix, waitForLixPrewarm } = createLixPrewarmer();
