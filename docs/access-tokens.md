# Create an access token

Use an API token to connect a script or internal app to a LixRay repository.

1. [Open LixRay](/open) and open the repository you want to use.
2. Open the repository's **Settings**.
3. Under **API tokens**, click **Generate token**.
4. Click **Copy token** and save it in your app's server environment as `LIX_ACCESS_TOKEN`. The token is shown only once.

Each token can read and write only that repository. Tokens expire after one
year and require you to remain a member of the repository.

Keep the token out of source control and browser code. To revoke it, return to
**Settings → API tokens** and click **Delete** next to the token. Apps using it
lose access immediately.

Continue with [Build an internal app](./internal-apps.md) to use the token with
the JavaScript SDK.
