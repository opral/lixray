export const DEMO_AUTH_TOKEN = "lixray-demo";
export const DEMO_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_ORGANIZATION_NAME = "acme";
export const DEMO_PROFILE_NAMESPACE_ID = "00000000-0000-4000-8000-000000000004";
export const DEMO_PROFILE_HANDLE = "samuel";
export const DEMO_PROFILE_NAME = "Samuel Stroschein";
export const DEMO_LIX_ID = "00000000-0000-4000-8000-000000000002";
export const DEMO_LIX_NAME = "launch-q3";
export const DEMO_CREATED_REPOSITORY_ID =
	"00000000-0000-4000-8000-000000000003";

export function demoProfileDocument(origin: string) {
	return {
		"@type": "Card",
		version: "2.0",
		kind: "individual",
		name: { full: DEMO_PROFILE_NAME },
		notes: {
			bio: {
				note: "Building Lix and LixRay at Opral. Version control for everything that isn't code.",
			},
		},
		organizations: { opral: { name: "Opral" } },
		titles: {
			founder: {
				kind: "title",
				name: "Founder",
				organizationId: "opral",
			},
		},
		addresses: { berlin: { full: "Berlin, Germany" } },
		links: {
			website: {
				uri: "https://samuelstroschein.com/",
				label: "samuelstroschein.com",
			},
			opral: { uri: "https://opral.com/", label: "opral.com" },
		},
		media: {
			avatar: {
				"@type": "Media",
				kind: "photo",
				uri: new URL("/samuel-profile.png", origin).href,
			},
		},
	};
}
