import assert from "node:assert/strict";
import test from "node:test";
import { googleOAuthSignInCredentials } from "./google-oauth.ts";

void test("Google sign-in always asks the user to select an account", () => {
	assert.deepEqual(googleOAuthSignInCredentials("https://lixray.com"), {
		provider: "google",
		options: {
			redirectTo: "https://lixray.com/auth/callback",
			queryParams: {
				prompt: "select_account",
			},
		},
	});
});
