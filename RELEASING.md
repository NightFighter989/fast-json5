# Releasing

Releases are published from GitHub Actions (`.github/workflows/release.yml`) when a `v*` tag is
pushed, with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

## One-time setup

1. Create the GitHub repository and replace the `OWNER` placeholders in `package.json`
   (`repository`, `homepage`, `bugs`). `npm run release:check` refuses to publish until you do,
   because provenance ties the package to that repository.
2. In the repository settings, create an environment named `npm`. The release job runs in it,
   so you can require an approval before anything is published.
3. **First publish.** npm only lets you configure trusted publishing for a package that already
   exists, so the first release needs a token:
   - Create a granular npm access token that can publish, and add it to the `npm` environment as
     the secret `NPM_TOKEN`.
4. **After the first publish**, switch to tokenless trusted publishing:
   - On npmjs.com, open the package's settings, add a *trusted publisher* for GitHub Actions with
     this repository and the workflow file `release.yml`, environment `npm`.
   - Delete the `NPM_TOKEN` secret and revoke the token.

## Each release

1. Update `version` in `package.json` and add a `## <version>` section to `CHANGELOG.md`.
2. Check locally:
   ```bash
   npm run build && npm run release:check
   ```
3. Commit, then tag and push:
   ```bash
   git tag v0.1.0 && git push origin main --tags
   ```
4. The release workflow runs `release:check` (which also verifies the tag matches the version),
   then `npm publish --provenance`. `prepublishOnly` runs typecheck, tests, build, runtime smoke
   tests and package lint first, so a broken build can't be published.

Before a release it's worth running the long fuzz pass locally too: `npm run test:fuzz`
(or trigger the *Fuzz* workflow manually).
