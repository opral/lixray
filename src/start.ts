import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { clerkPublishableKey } from "./lib/clerk-env";

const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});
const isE2eAuthEnabled = import.meta.env.VITE_LIXRAY_E2E === "1";

export const startInstance = createStart(() => ({
	requestMiddleware: [
		...(isE2eAuthEnabled
			? []
			: [clerkMiddleware({ publishableKey: clerkPublishableKey })]),
		csrfMiddleware,
	],
}));
