interface ImportMetaEnv {
	readonly VITE_LIXRAY_RELEASE_ID?: string;
	readonly VITE_PUBLIC_POSTHOG_HOST?: string;
	readonly VITE_PUBLIC_POSTHOG_TOKEN?: string;
	readonly VITE_PUBLIC_TELEMETRY_ENVIRONMENT?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
