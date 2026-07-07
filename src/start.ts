import { clerkMiddleware } from "@clerk/tanstack-react-start/server";
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { clerkPublishableKey } from "./lib/clerk-env";

const csrfMiddleware = createCsrfMiddleware({
	filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
	requestMiddleware: [
		clerkMiddleware({ publishableKey: clerkPublishableKey }),
		csrfMiddleware,
	],
}));
