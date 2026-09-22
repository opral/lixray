# Reporting a security issue

Email [hello@opral.com](mailto:hello@opral.com) to report suspected vulnerabilities,
exposed credentials, or private data in LixRay. Include the affected component,
steps to reproduce, and the relevant commit or issue URL. Redact credentials and
personal data; do not include live tokens or customer content in the report.

Use this private channel for security reports instead of a public issue or pull
request. Ordinary bugs and feature requests can be filed in GitHub issues.

If a credential has been committed or posted, revoke or rotate it before relying
on a file deletion. A cleanup commit does not remove earlier versions, pull
request diffs, comments, logs, artifacts, or existing clones. Repository owners
should follow [GitHub's sensitive-data removal procedure](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
when historical removal is needed.
