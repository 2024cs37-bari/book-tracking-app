# Security policy

## Scope

Personal Book Reader handles private library metadata, reading progress, annotations, and original book files. Security priorities are authenticated access, private object storage, integrity verification, safe parsing, and minimal exposure of personal content.

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Contact the repository owner through a private GitHub security advisory or private maintainer contact configured on the repository. Include:

- A concise description and affected component/version or commit.
- Reproduction steps or a minimal proof of concept that does not access other people's data.
- Impact and any suggested mitigation.
- Your preferred contact details for follow-up.

Do not include credentials, active signed URLs, personal book files, annotation contents, or other private data. If sensitive data was exposed, revoke/rotate it and report the exposure without forwarding the secret.

There is no guaranteed response or reward policy yet. The maintainer will acknowledge reports when possible, validate impact, coordinate a fix, and publish appropriate release guidance without exposing unnecessary details.

## Security requirements

- Every API route requires authenticated, authorized access.
- R2 remains private; object access uses scoped, short-lived authorization.
- Original file hashes are verified on import and download.
- File parsers and archives are treated as untrusted input and resource-limited.
- Secrets, tokens, signed URLs, and user content are excluded from logs and commits.
- No DRM circumvention is implemented or supported.
- Dependencies and deployment service configuration are reviewed before production.
- App CSP precedes scripts; book frames inherit it and EPUB resources receive a stricter no-script,
  no-network policy before URL creation. Generated hostile EPUB browser tests must pass on engine
  updates; upstream sandbox flags alone are not a security boundary.
- Client-side encryption is not part of the initial baseline; private storage must not be described as end-to-end encrypted.

## Privacy

The product does not require analytics or third-party tracking. Any future telemetry, external metadata enrichment, or diagnostics upload must have a separate documented privacy decision and user-visible behavior.
