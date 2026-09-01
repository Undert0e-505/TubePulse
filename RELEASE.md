# TubePulse Release Process

**Status:** Current process and target cleanup plan. This document describes what the release tooling does today and the safer flow the repo should move toward. It does not change release behavior by itself.

For current app version evidence, start with `app.json` and `android/app/build.gradle`. `package.json` is tooling/package metadata and is not the app release version.

Worker deployments are deliberately separate from app APK releases. Do not deploy the API or scheduled Workers as part of an app release unless that is an explicit worker deployment task.

---

## Current Release Script

The current local app release path is:

```powershell
.\build-and-release.ps1 3.2.5
```

The script is Windows-native. Full release and validate-only modes require a version argument; build-only mode uses the checked-in version.

| Argument | Meaning |
|---|---|
| `Version` | Required app version for full release and `-ValidateOnly`, for example `3.2.5` |
| `-Message` | Optional custom commit message suffix |
| `-BuildOnly` | Builds the checked-in app version, signs, verifies, and copies the APK without editing version files or running Git/GitHub release steps |
| `-Clean` | Deletes local Gradle build/cache folders before building |
| `-ValidateOnly` | Runs release preflight checks only, then exits without changing files or publishing |

Build the checked-in version without changing source files:

```powershell
.\build-and-release.ps1 -BuildOnly
```

Supplying `Version` with `-BuildOnly` is rejected because build-only always uses the checked-in app version.

Current full-release behavior, in order:

1. Determines the current Git branch.
2. Verifies local tool paths for JDK 21, Android SDK, `apksigner`, `aapt2`, `curl.exe`, `android/app/debug.keystore`, and `android/gradlew.bat`.
3. Optionally removes `android/app/build`, `android/build`, and `android/.gradle` when `-Clean` is set. `-Clean` is not allowed with `-BuildOnly` or `-ValidateOnly`.
4. Updates app version files:
   - `app.json` `expo.version`
   - `android/app/build.gradle` `versionName`
   - `android/app/build.gradle` `versionCode`
5. Derives `versionCode` by stripping dots from the requested version, for example `3.2.4` becomes `324`.
6. Runs `npm install --no-audit --no-fund`.
7. Runs `android\gradlew.bat assembleRelease --no-daemon`.
8. Signs `android/app/build/outputs/apk/release/app-release.apk` with `android/app/debug.keystore`.
9. Verifies the APK signature and APK version metadata.
10. Copies the APK to `dist/TubePulse-vX.Y.Z.apk`.
11. If `-BuildOnly` is not set:
    - blocks on untracked non-ignored files
    - verifies only known release version files have tracked changes
    - stages only `app.json` and `android/app/build.gradle`
    - commits as `Jimothy <Jimothy@local>` and exits if commit fails
    - pushes the current branch and exits if push fails
    - creates or reuses a GitHub Release through the GitHub API only after the release commit is pushed
    - uploads the `dist/` APK with `curl.exe`

The GitHub token is read from Git's credential helper. The script does not require the GitHub CLI.

### Build-Only Flow

`-BuildOnly` runs tool verification, reads `app.json` `expo.version`, `android/app/build.gradle` `versionName`, and `android/app/build.gradle` `versionCode`, and requires the app JSON version to match Gradle `versionName`. It then builds, signs, verifies, and copies `dist/TubePulse-vCURRENT.apk` using the checked-in Gradle version metadata.

`-BuildOnly` does not edit `app.json` or `android/app/build.gradle`, does not stage or commit files, does not push, and does not create or upload GitHub releases.

### Validate-Only Preflight

Run a release preflight without modifying the working tree:

```powershell
.\build-and-release.ps1 9.9.9 -ValidateOnly
```

`-ValidateOnly` checks required local tools and paths, the current Git branch/repository state, untracked non-ignored files, unrelated tracked changes, and numeric `X.Y.Z` version syntax. It also prints the intended tag, APK name, `dist/` output path, version file paths, and current app/build Gradle version metadata.

`-ValidateOnly` deliberately does not edit `app.json` or `android/app/build.gradle`, run `npm install`, run Gradle, sign or copy APKs, stage files, commit, push, create GitHub releases, or upload APKs. It cannot be combined with `-BuildOnly` or `-Clean`.

---

## Current Local Artifacts

The current script writes final APKs to `dist/` using:

```text
TubePulse-vX.Y.Z.apk
```

The repo root currently contains historical local APK artifacts. They are ignored by `.gitignore` through the `*.apk` rule and are not tracked. New script output goes under ignored `dist/` instead of creating more root APK clutter.

Local APK output should use `dist/`, not `releases/`.

Reason: GitHub Releases should own durable release history. `dist/` should be disposable local build output.

---

## Current Risks

The current release process works, but it has too much authority in one command:

- `build-and-release.ps1` combines version bumping, dependency install, build, signing, Git commit, Git push, GitHub release creation, and APK upload.
- Historical root APK output created local clutter and made it harder to see what is source versus generated output. New APK output should stay under ignored `dist/`.
- Release commits now stage only `app.json` and `android/app/build.gradle`, and the script blocks unrelated tracked changes before committing.
- Commit and push failures are fatal before GitHub release creation or APK upload.
- Release signing currently uses `android/app/debug.keystore`; this is current behavior, not a reviewed long-term signing policy.
- `versionCode` is derived by stripping dots. This can create future ordering problems, for example when version segments become more than one digit.
- `package.json` has its own `version`, but that is tooling metadata and should not be treated as the app release version.
- Google Services ownership is confusing: `app.json` points at the ignored root `google-services.json`, while `android/app/google-services.json` is tracked and used by the Android project.
- Validate-only mode exists for release preflight checks.
- Build-only mode builds the checked-in version without editing version files.
- There is no explicit post-build install/smoke-test step.

---

## Intended Target Flow

The target release process should be split into smaller, safer commands.

### 1. Build-Only Flow

Purpose: build the current checked-in app version for local testing.

Expected behavior:

- Validates required local tools.
- Builds the current checked-in version.
- Writes the APK to `dist/`.
- Verifies APK version/signature.
- Does not modify version files.
- Does not commit, push, tag, create GitHub releases, or deploy workers.

### 2. Prepare-Release Flow

Purpose: create a predictable release version commit.

Expected behavior:

- Validates a clean working tree.
- Updates only known version files:
  - `app.json`
  - `android/app/build.gradle`
- Uses an explicit documented `versionCode` rule.
- Stages only `app.json` and `android/app/build.gradle`.
- Creates a predictable release commit.
- Does not build/upload unless that is a deliberate next step.

### 3. Release/Upload Flow

Purpose: publish the already-prepared app release.

Expected behavior:

- Requires a clean working tree.
- Requires the release commit to be pushed.
- Builds the APK into `dist/`.
- Verifies APK version/signature.
- Creates or updates the GitHub Release.
- Uploads the exact `dist/` artifact.
- Fails if commit or push state is not safe.
- Does not deploy workers.

### 4. Worker Deploy Flow

Purpose: deploy Cloudflare workers deliberately and separately.

Expected behavior:

- Deploy `worker/tubepulse-api` only when API worker changes require it.
- Deploy the affected active scheduled workers individually: `worker/tubepulse-rss-0`, `worker/tubepulse-rss-1`, `worker/tubepulse-rss-2`, `worker/tubepulse-posts`, and `worker/tubepulse-aux`.
- Keep `worker/tubepulse-cron` deployed as a no-op with `crons = []`; do not use it for background-worker releases.
- Never deploy archived workers unless deliberately restoring historical behavior.
- Never bundle worker deploys into app APK release automation.

---

## Staged Cleanup Plan

Recommended small commits:

1. `docs: document release process and risks`
2. `chore: ignore local release output directories`
3. `chore: move APK output to dist` - done
4. `chore: narrow release script git staging`
5. `chore: make commit/push failures fatal`
6. `chore: add validate-only mode`
7. Later: review signing, Google Services ownership, and `versionCode` policy.

Historical local APKs can be deleted locally after confirming they are ignored and no longer needed for manual rollback. Do not commit those artifacts.
