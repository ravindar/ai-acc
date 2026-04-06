# macOS Signing and Notarization

This project packages the desktop app with Tauri and supports signed/notarized macOS releases through a shared local script and CI workflow.

## Outputs

- Local or CI release command: `pnpm desktop:release:macos`
- CI workflow: [release-macos.yml](/Users/ravindargujral/Downloads/ai-ace/.github/workflows/release-macos.yml)
- Local release script: [release-macos.sh](/Users/ravindargujral/Downloads/ai-ace/scripts/release-macos.sh)

## Required inputs

For code signing:

- `APPLE_CERTIFICATE`: base64-encoded `Developer ID Application` certificate
- `APPLE_CERTIFICATE_PASSWORD`: password for the exported certificate
- `APPLE_SIGNING_IDENTITY`: signing identity name, for example `Developer ID Application: Example Inc. (TEAMID1234)`

For notarization, use one of the following:

- Recommended App Store Connect API key flow
- `APPLE_API_ISSUER`
- `APPLE_API_KEY`
- `APPLE_API_PRIVATE_KEY` locally, or `APPLE_API_KEY_PATH` if a key file already exists

- Legacy Apple ID flow
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

## Local release

1. Export the signing and notarization variables in your shell.
2. Run `pnpm desktop:release:macos`.
3. Find the resulting `.dmg` under `apps/desktop/src-tauri/target/release/bundle/dmg/`.

The release script defaults to `universal-apple-darwin` so one installer works across Apple Silicon and Intel Macs.

## CI release

1. Add the same values as GitHub Actions secrets.
2. Trigger the `Release macOS` workflow manually or push a `v*` tag.
3. The workflow uploads the `.dmg` artifact and, on tags, attaches it to a GitHub release.

## Notes

- The release script will try to auto-detect a local `Developer ID Application` identity if `APPLE_SIGNING_IDENTITY` is not set.
- If notarization credentials are missing, the script warns and still produces a signed build when signing credentials exist.
- Official references:
  - [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)
  - [Tauri GitHub pipelines](https://v2.tauri.app/distribute/pipelines/github/)
  - [Apple notarization with notarytool](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
