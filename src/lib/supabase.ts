import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

export type LixraySupabaseClient = SupabaseClient<Database>;

const env = import.meta.env as {
	readonly VITE_SUPABASE_URL?: string;
	readonly VITE_SUPABASE_KEY?: string;
};

export const supabaseUrl = env.VITE_SUPABASE_URL;
export const supabasePublishableKey = env.VITE_SUPABASE_KEY;

if (!supabaseUrl) {
	throw new Error("VITE_SUPABASE_URL is required");
}
if (!supabasePublishableKey) {
	throw new Error("VITE_SUPABASE_KEY is required");
}

let browserClient: LixraySupabaseClient | undefined;

export function getBrowserSupabaseClient(): LixraySupabaseClient {
	if (typeof window === "undefined") {
		throw new Error("The Supabase browser client is unavailable on the server");
	}

	browserClient ??= createClient<Database>(
		supabaseUrl!,
		supabasePublishableKey!,
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
