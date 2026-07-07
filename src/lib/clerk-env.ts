export const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!clerkPublishableKey) {
	throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required");
}
