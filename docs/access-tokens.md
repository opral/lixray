# Create an access token

Use an account API token to connect Flashtype, scripts, or internal apps to Lixray.

1. Open your [account settings](https://lixray.com/settings), such as `/settings/@samuel`.
2. Under **API tokens**, click **Generate token**.
3. Copy the token. It is shown only once.
4. Paste it into Flashtype's **Share** dialog, or save it in your app's server environment as `LIXRAY_ACCESS_TOKEN`.

Each token has your account's permissions, including access to repositories you
create later. Tokens expire after one year. Losing repository access also removes
the token's access to it.

To revoke a token, return to account settings and click **Delete** next to it.
Keep tokens out of source control and public browser code.

Repository settings no longer contain API tokens. The account-token migration
revokes existing repository tokens; generate a new account token to reconnect.

Continue with [Build an internal app](./internal-apps.md).
