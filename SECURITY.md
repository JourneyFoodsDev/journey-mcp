# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** button (Security tab) on this repository. Do not open a public issue. Include the steps to reproduce and the impact. We aim to reply within 3 business days. Thank you for helping keep Journey users safe.

## Design notes

- Every tool is read-only.
- Keys come only from the environment or the request header. They are never logged, stored or returned, and each key is only sent to the service that issued it.
- Usage events record the account, tool, counts, client and latency. They never record arguments or returned data.
- Caps and rate limits belong to the company or account, not to an API key, and are enforced on the server, not by the client.
