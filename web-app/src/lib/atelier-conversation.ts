import * as atelier from "@opral/atelier";
import type { Lix } from "@lix-js/sdk";
import type { ConversationNameParts } from "./atelier-navigation.ts";

/**
 * Atelier's conversation-view contract, typed here because the package's
 * declarations do not carry it yet: `scripts/prune-types.mjs` in Atelier
 * keeps an allowlist of public `.d.ts` files, and the new
 * `extensions/conversation/*` declarations are not on it, so these exports
 * resolve to unresolved types for a consumer. The values are Atelier's own.
 * Import from `@opral/atelier` directly once its declarations include them.
 */
const conversationExports = atelier as unknown as {
	readonly ATELIER_CONVERSATION_VIEW_ID: "atelier_conversation";
	readonly selectConversationSummary: (
		lix: Lix,
		conversationId: string,
	) => Promise<
		| (ConversationNameParts & {
				readonly id: string;
				readonly removed: boolean;
		  })
		| null
	>;
};

export const ATELIER_CONVERSATION_VIEW_ID =
	conversationExports.ATELIER_CONVERSATION_VIEW_ID;

export const selectConversationSummary =
	conversationExports.selectConversationSummary;
