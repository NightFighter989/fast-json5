# Releasing

`npm publish` always runs `prepublishOnly` first: typecheck, tests, the long fuzz pass (200k
cases per property, about a minute), build, runtime smoke tests and package lint. So nothing
broken can be published, whichever way you publish.

There are two ways to publish. Both start the same way:

1. Update `version` in `package.json` and add a `## <version>` section to `CHANGELOG.md`.
2. Check locally:
   ```bash
   npm run build && npm run release:check
   ```
3. Commit and push.

## From GitHub Actions (recommended: adds provenance)

`.github/workflows/release.yml` publishes when a `v*` tag is pushed. It's the only way to get
[npm provenance](https://docs.npmjs.com/generating-provenance-statements), the verified link
from the npm package back to this repository and commit. It runs only on tags, so it costs a
couple of minutes per release.

**One-time setup:**
1. npm only lets you configure trusted publishing for a package that already exists, so the
   first release needs a token. On npmjs.com, create a granular access token that can publish
   packages, then in the GitHub repository go to *Settings → Environments*, create an environment
   named `npm`, and add the token there as the secret `NPM_TOKEN`. (Adding required reviewers
   to that environment makes every publish wait for your approval.)
2. After the first publish, switch to tokenless trusted publishing: on npmjs.com open the
   package's *Settings*, add a *trusted publisher* for GitHub Actions with repository
   `NightFighter989/fast-json5`, workflow `release.yml` and environment `npm`. Then delete the
   `NPM_TOKEN` secret and revoke the token.

**Each release:**
```bash
git tag v0.1.0
git push origin v0.1.0
```
The workflow builds, runs `release:check` (which also verifies the tag matches the version), and
publishes.

## From your machine

```bash
npm login
npm publish --access public
```
This works without any GitHub setup, but the package has no provenance (`--provenance` only
works from a supported CI system). You can still use the Actions route for later releases.
