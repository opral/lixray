export const isE2eAuthEnabled = import.meta.env.VITE_LIXRAY_E2E === "1";
export const isPreviewMode = import.meta.env.VITE_LIXRAY_PREVIEW === "1";
export const usesFixtureWorkspace = isE2eAuthEnabled || isPreviewMode;
