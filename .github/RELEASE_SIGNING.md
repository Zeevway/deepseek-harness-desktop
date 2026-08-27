# Release signing policy

Windows Authenticode signing is intentionally disabled for the current release line.
The CI workflow rejects `CSC_LINK` and `WIN_CSC_LINK` so a credential cannot silently
change the stated release policy. Release manifests record
`"policy": "unsigned-by-user-request"`.

If the policy changes later, add a protected signing job between build and metadata
generation, sign the installer and packaged executable with an RFC 3161 timestamp,
then change the manifest policy and CI credential guard in the same reviewed change.
