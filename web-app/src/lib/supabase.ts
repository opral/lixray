import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

export type LixraySupabaseClient = SupabaseClient<Database>;

const env = import.meta.env as {
	readonly VITE_LIXRAY_DEMO?: string;
	readonly VITE_LIXRAY_LOCAL_DEV?: string;
	readonly VITE_LIXRAY_LOCAL_DEV_EMAIL?: string;
	readonly VITE_LIXRAY_LOCAL_DEV_PASSWORD?: string;
	readonly VITE_SUPABASE_URL?: string;
	readonly VITE_SUPABASE_KEY?: string;
};

const configuredSupabaseUrl = env.VITE_SUPABASE_URL;
// In local development, use the page origin in the browser. This keeps
// tunneled previews on the same origin as the Vite Supabase proxy instead of
// resolving 127.0.0.1 inside the browser's separate environment.
const supabaseUrl =
	env.VITE_LIXRAY_LOCAL_DEV === "1" && typeof window !== "undefined"
		? window.location.origin
		: configuredSupabaseUrl;
const supabasePublishableKey = env.VITE_SUPABASE_KEY;
export const localDevCredentials =
	env.VITE_LIXRAY_LOCAL_DEV === "1" &&
	env.VITE_LIXRAY_LOCAL_DEV_EMAIL &&
	env.VITE_LIXRAY_LOCAL_DEV_PASSWORD
		? {
				email: env.VITE_LIXRAY_LOCAL_DEV_EMAIL,
				password: env.VITE_LIXRAY_LOCAL_DEV_PASSWORD,
			}
		: null;

if (env.VITE_LIXRAY_DEMO !== "1" && !supabaseUrl) {
	throw new Error("VITE_SUPABASE_URL is required");
}
if (env.VITE_LIXRAY_DEMO !== "1" && !supabasePublishableKey) {
	throw new Error("VITE_SUPABASE_KEY is required");
}

let browserClient: LixraySupabaseClient | undefined;

export function getBrowserSupabaseClient(): LixraySupabaseClient {
	if (typeof window === "undefined") {
		throw new Error("The Supabase browser client is unavailable on the server");
	}
	if (!supabaseUrl || !supabasePublishableKey) {
		throw new Error("Supabase is unavailable in demo mode");
	}

	browserClient ??= createClient<Database>(
		supabaseUrl,
		supabasePublishableKey,
		{
			auth: {
				flowType: "pkce",
				persistSession: true,
				autoRefreshToken: true,
				detectSessionInUrl: false,
			},
		},
	);
	return browserClient;
}
