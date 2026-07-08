const env = import.meta.env as {
	readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
};

export const clerkPublishableKey = env.VITE_CLERK_PUBLISHABLE_KEY;

if (!clerkPublishableKey) {
	throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
}
