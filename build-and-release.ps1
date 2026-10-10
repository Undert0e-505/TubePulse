# ============================================================
# TubePulse -- Local APK Build & GitHub Release (Windows-native)
# ============================================================
# One command: version bump, build, sign, commit, push, release.
# No WSL, no EAS, no gh CLI required.
#
# Usage:
#   .\build-and-release.ps1 3.1.9              # full release on current branch
#   .\build-and-release.ps1 -BuildOnly         # build checked-in version, no edits/git/release
#   .\build-and-release.ps1 3.1.9 -ValidateOnly # preflight only, no changes
#   .\build-and-release.ps1 3.1.9 -Clean       # nuke gradle cache first
#   .\build-and-release.ps1 3.1.9 -Message "Fix widget tap"  # custom commit msg
#
# What it does (in order):
#   1. Bump version in app.json + build.gradle (versionCode = dots stripped)
#   2. npm install
#   3. Gradle assembleRelease
#   4. Sign APK with apksigner (debug keystore)
#   5. Stage version files, commit, push to origin
#   6. Create GitHub release via API, upload signed APK via curl
#
# Requirements (all on this Windows host):
#   - JDK 21 at C:\Program Files\Java\jdk-21
#   - Android SDK at D:\dev\android-sdk
#   - curl.exe (built into Windows 10+)
#   - git with credential helper (PAT in Windows Credential Manager)
# ============================================================

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Version,

    [Parameter(Position = 1)]
    [string]$Message = "",

    [switch]$BuildOnly,

    [switch]$Clean,

    [switch]$ValidateOnly,

    [string]$BuildOnlyVersionCodeOverride = ''
)

# --- Constants ---
$APP_NAME = "TubePulse"
$REPO = "Undert0e-505/TubePulse"
$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) { $SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path }
$REPO_DIR = $SCRIPT_DIR
$DIST_DIR = Join-Path $REPO_DIR "dist"
$APP_JSON_PATH = Join-Path $REPO_DIR "app.json"
$BUILD_GRADLE_PATH = Join-Path $REPO_DIR "android\app\build.gradle"
$RELEASE_VERSION_FILES = @(
    "app.json",
    "android/app/build.gradle"
)

$JDK_PATH = "C:\Program Files\Java\jdk-21"
$ANDROID_SDK = "D:\dev\android-sdk"
$GIT_AUTHOR = "Jimothy"
$GIT_EMAIL = "Jimothy@local"
$UTF8_NO_BOM = [System.Text.UTF8Encoding]::new($false)

function Get-CheckedInVersionMetadata {
    $appJson = Get-Content $APP_JSON_PATH -Raw | ConvertFrom-Json
    $buildGradle = Get-Content $BUILD_GRADLE_PATH -Raw
    $gradleVersionName = $null
    $gradleVersionCode = $null
    if ($buildGradle -match 'versionName "([^"]+)"') { $gradleVersionName = $Matches[1] }
    if ($buildGradle -match 'versionCode (\d+)') { $gradleVersionCode = $Matches[1] }

    if (-not $appJson.expo.version) {
        Write-Error "Could not read expo.version from app.json."
        exit 1
    }
    if (-not $gradleVersionName) {
        Write-Error "Could not read versionName from android\app\build.gradle."
        exit 1
    }
    if (-not $gradleVersionCode) {
        Write-Error "Could not read versionCode from android\app\build.gradle."
        exit 1
    }

    [PSCustomObject]@{
        AppVersion = [string]$appJson.expo.version
        GradleVersionName = [string]$gradleVersionName
        GradleVersionCode = [string]$gradleVersionCode
    }
}

if ($ValidateOnly -and ($BuildOnly -or $Clean)) {
    Write-Error "-ValidateOnly cannot be combined with -BuildOnly or -Clean."
    exit 1
}
if ($BuildOnlyVersionCodeOverride -and -not $BuildOnly) {
    Write-Error "-BuildOnlyVersionCodeOverride is allowed only with -BuildOnly."
    exit 1
}
if ($BuildOnlyVersionCodeOverride -and $BuildOnlyVersionCodeOverride -notmatch '^[1-9][0-9]*$') {
    Write-Error "-BuildOnlyVersionCodeOverride must be a positive integer."
    exit 1
}
if ($BuildOnly -and $Clean) {
    Write-Error "-BuildOnly cannot be combined with -Clean."
    exit 1
}
if ($BuildOnly -and $Version) {
    Write-Error "-BuildOnly builds the checked-in version and does not accept a Version argument. Run .\build-and-release.ps1 -BuildOnly."
    exit 1
}
if ($ValidateOnly -and -not $Version) {
    Write-Error "-ValidateOnly requires a Version argument. Example: .\build-and-release.ps1 9.9.9 -ValidateOnly"
    exit 1
}
if (-not $BuildOnly -and -not $ValidateOnly -and -not $Version) {
    Write-Error "Full release requires a Version argument. Example: .\build-and-release.ps1 3.2.5"
    exit 1
}

if ($BuildOnly) {
    $checkedInVersion = Get-CheckedInVersionMetadata
    if ($checkedInVersion.AppVersion -ne $checkedInVersion.GradleVersionName) {
        Write-Error "BuildOnly blocked: app.json expo.version ($($checkedInVersion.AppVersion)) does not match android\app\build.gradle versionName ($($checkedInVersion.GradleVersionName))."
        exit 1
    }
    $Version = $checkedInVersion.AppVersion
    $versionCode = $checkedInVersion.GradleVersionCode
    $expectedApkVersionCode = $versionCode
    if ($BuildOnlyVersionCodeOverride) {
        $overrideCode = 0
        if (-not [int]::TryParse($BuildOnlyVersionCodeOverride, [ref]$overrideCode)) {
            Write-Error "-BuildOnlyVersionCodeOverride exceeds the supported Android integer range."
            exit 1
        }
        if ($overrideCode -le [int]$versionCode) {
            Write-Error "-BuildOnlyVersionCodeOverride ($overrideCode) must be greater than the checked-in versionCode ($versionCode)."
            exit 1
        }
        $expectedApkVersionCode = [string]$overrideCode
    }
}
# Branch
$Branch = (git rev-parse --abbrev-ref HEAD 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Error "Could not determine current branch."
    exit 1
}

$TAG = "v$Version"
$APK_NAME = "$APP_NAME-$TAG.apk"
$APK_PATH = Join-Path $DIST_DIR $APK_NAME

function Write-File-NoBom([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, $UTF8_NO_BOM)
}

function Assert-NoUntrackedFiles {
    $status = git status --porcelain 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Could not check git status before staging."
        exit 1
    }

    $untracked = @($status | Where-Object { $_.StartsWith('?? ') } | ForEach-Object { $_.Substring(3) })
    if ($untracked.Count -eq 0) { return }

    Write-Host ""
    Write-Host "Release blocked: untracked non-ignored files are present." -ForegroundColor Red
    Write-Host "The release script refuses to continue until these files are committed, moved, deleted, or ignored:" -ForegroundColor Yellow
    foreach ($file in $untracked) {
        Write-Host "  $file" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Error "Move, delete, commit, or ignore these files before releasing."
    exit 1
}

function Assert-OnlyReleaseVersionChanges {
    $status = git status --porcelain 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Could not check git status before staging."
        exit 1
    }

    $unexpected = @()
    foreach ($line in $status) {
        if ($line.StartsWith('?? ')) { continue }
        if ($line.Length -lt 4) { continue }

        $state = $line.Substring(0, 2)
        $path = $line.Substring(3)
        $normalizedPath = $path -replace '\\', '/'
        $isReleaseVersionFile = $RELEASE_VERSION_FILES -contains $normalizedPath
        $isModifiedOnly = ($state[0] -eq ' ' -or $state[0] -eq 'M') -and ($state[1] -eq ' ' -or $state[1] -eq 'M')

        if (-not $isReleaseVersionFile -or -not $isModifiedOnly) {
            $unexpected += $line
        }
    }

    if ($unexpected.Count -eq 0) { return }

    Write-Host ""
    Write-Host "Release blocked: unexpected tracked changes are present." -ForegroundColor Red
    Write-Host "Only these version files may be modified for this release commit:" -ForegroundColor Yellow
    foreach ($file in $RELEASE_VERSION_FILES) {
        Write-Host "  $file" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Unexpected tracked changes:" -ForegroundColor Yellow
    foreach ($line in $unexpected) {
        Write-Host "  $line" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Error "Commit, revert, or move unrelated tracked changes before releasing."
    exit 1
}
function Assert-ValidateOnlyVersionSyntax {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        Write-Error "ValidateOnly failed: Version must use numeric X.Y.Z format, for example 3.2.5."
        exit 1
    }
}

function Invoke-ValidateOnlyPreflight {
    Write-Host ""
    Write-Host "[validate] Checking release preflight only..." -ForegroundColor Cyan

    Assert-ValidateOnlyVersionSyntax
    Assert-NoUntrackedFiles
    Assert-OnlyReleaseVersionChanges

    $appJsonPath = Join-Path $REPO_DIR "app.json"
    $buildGradlePath = Join-Path $REPO_DIR "android\app\build.gradle"
    $appJson = Get-Content $appJsonPath -Raw | ConvertFrom-Json
    $buildGradle = Get-Content $buildGradlePath -Raw
    $currentVersionName = "unknown"
    $currentVersionCode = "unknown"
    if ($buildGradle -match 'versionName "([^"]+)"') { $currentVersionName = $Matches[1] }
    if ($buildGradle -match 'versionCode (\d+)') { $currentVersionCode = $Matches[1] }

    Write-Host "  Git branch: $Branch"
    Write-Host "  Requested version: $Version"
    Write-Host "  Current app.json expo.version: $($appJson.expo.version)"
    Write-Host "  Current build.gradle versionName: $currentVersionName"
    Write-Host "  Current build.gradle versionCode: $currentVersionCode"
    Write-Host "  Intended tag: $TAG"
    Write-Host "  Intended APK name: $APK_NAME"
    Write-Host "  Intended dist path: $APK_PATH"
    Write-Host "  app.json path: $appJsonPath"
    Write-Host "  build.gradle path: $buildGradlePath"
    Write-Host ""
    Write-Host "  ValidateOnly complete. No files were changed, built, staged, committed, pushed, released, or uploaded." -ForegroundColor Cyan
    exit 0
}
# --- Banner ---
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  $APP_NAME - Build and Release $TAG" -ForegroundColor Cyan
Write-Host "  Branch: $Branch" -ForegroundColor Cyan
if ($Message) { Write-Host "  Message: $Message" -ForegroundColor Cyan }
if ($ValidateOnly) { Write-Host "  Mode: ValidateOnly" -ForegroundColor Cyan }
Write-Host "  JDK: $JDK_PATH" -ForegroundColor Cyan
Write-Host "  SDK: $ANDROID_SDK" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# --- Verify tools ---
Write-Host "[0/7] Verifying build tools..."

if (-not (Test-Path "$JDK_PATH\bin\java.exe")) {
    Write-Error "JDK not found at $JDK_PATH"
    exit 1
}
Write-Host "  JDK 21  OK"

if (-not (Test-Path "$ANDROID_SDK\platform-tools\adb.exe")) {
    Write-Error "Android SDK not found at $ANDROID_SDK"
    exit 1
}
Write-Host "  Android SDK  OK"

$apksigner = Get-ChildItem "$ANDROID_SDK\build-tools" -Recurse -Filter "apksigner.bat" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $apksigner) {
    Write-Error "apksigner.bat not found in $ANDROID_SDK\build-tools"
    exit 1
}
Write-Host "  apksigner  OK"

$aapt = Get-ChildItem "$ANDROID_SDK\build-tools" -Recurse -Filter "aapt2.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $aapt) {
    Write-Error "aapt2.exe not found in $ANDROID_SDK\build-tools"
    exit 1
}
Write-Host "  aapt2  OK"

if (-not (Test-Path "$REPO_DIR\android\app\debug.keystore")) {
    Write-Error "debug.keystore not found at android\app\debug.keystore"
    exit 1
}
Write-Host "  debug.keystore  OK"

if (-not (Test-Path "$REPO_DIR\android\gradlew.bat")) {
    Write-Error "gradlew.bat not found at android\gradlew.bat"
    exit 1
}
Write-Host "  gradlew.bat  OK"

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    Write-Error "curl.exe not found on PATH"
    exit 1
}
Write-Host "  curl.exe  OK"

if ($ValidateOnly) {
    Invoke-ValidateOnlyPreflight
}

# --- Set environment ---
$env:JAVA_HOME = $JDK_PATH
$env:ANDROID_HOME = $ANDROID_SDK
$env:ANDROID_SDK_ROOT = $ANDROID_SDK
$env:PATH = "$JDK_PATH\bin;$ANDROID_SDK\platform-tools;$env:PATH"

Set-Location "$REPO_DIR"

# --- Optional: clean ---
if ($Clean) {
    Write-Host ""
    Write-Host "[clean] Removing gradle caches..."
    Remove-Item -Recurse -Force "android\app\build", "android\build", "android\.gradle" -ErrorAction SilentlyContinue
    Write-Host "  done"
}

# --- Step 1: Version selection/bump ---
if ($BuildOnly) {
    Write-Host ""
    Write-Host "[1/7] Using checked-in version $Version (versionCode=$versionCode)..."
    if ($BuildOnlyVersionCodeOverride) {
        Write-Host "  manifest versionCode override: $expectedApkVersionCode"
    }
    Write-Host "  app.json  unchanged"
    Write-Host "  build.gradle  unchanged"
} else {
    Write-Host ""
    Write-Host "[1/7] Bumping version to $Version..."

    $appJsonPath = $APP_JSON_PATH
    $appJson = Get-Content $appJsonPath -Raw | ConvertFrom-Json
    $appJson.expo.version = $Version
    Write-File-NoBom $appJsonPath ($appJson | ConvertTo-Json -Depth 10)
    Write-Host "  app.json  OK"

    $buildGradlePath = $BUILD_GRADLE_PATH
    $buildGradle = Get-Content $buildGradlePath -Raw
    $versionCode = $Version -replace '\.', ''
    $buildGradle = $buildGradle -replace 'versionCode \d+', "versionCode $versionCode"
    $buildGradle = $buildGradle -replace 'versionName "[^"]+"', "versionName `"$Version`""
    Write-File-NoBom $buildGradlePath $buildGradle
    $expectedApkVersionCode = $versionCode
    Write-Host "  build.gradle (versionCode=$versionCode)  OK"
}
# --- Step 2: npm install ---
Write-Host ""
Write-Host "[2/7] npm install..."
if ($BuildOnly) {
    npm install --no-audit --no-fund --package-lock=false 2>&1 | Select-Object -Last 2
} else {
    npm install --no-audit --no-fund 2>&1 | Select-Object -Last 2
}
Write-Host "  done  OK"

# --- Step 3: Gradle build ---
Write-Host ""
Write-Host "[3/7] Building APK with Gradle..."
Set-Location "$REPO_DIR\android"
$gradleArguments = @('assembleRelease', '--no-daemon')
$previewVersionInitScriptPath = $null
if ($BuildOnlyVersionCodeOverride) {
    $previewVersionInitDirectory = Join-Path $REPO_DIR 'logs\build-runner'
    New-Item -ItemType Directory -Path $previewVersionInitDirectory -Force | Out-Null
    Get-ChildItem -LiteralPath $previewVersionInitDirectory -Filter 'feature-preview-version-code-*.init.gradle' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddHours(-12) } |
        Remove-Item -Force
    $previewVersionInitScriptPath = Join-Path $previewVersionInitDirectory ("feature-preview-version-code-{0}.init.gradle" -f [Guid]::NewGuid().ToString('N'))
    $previewVersionInitScript = @"
gradle.beforeProject { project ->
    if (project.path == ':app' && project.rootProject == gradle.rootProject) {
        project.plugins.withId('com.android.application') {
            project.extensions.getByName('android').applicationVariants.all { variant ->
                if (variant.buildType.name == 'release') {
                    variant.outputs.all { output ->
                        output.versionCodeOverride = $expectedApkVersionCode
                    }
                }
            }
        }
    }
}
"@
    [System.IO.File]::WriteAllText($previewVersionInitScriptPath, $previewVersionInitScript, $UTF8_NO_BOM)
    $gradleArguments += @('--init-script', $previewVersionInitScriptPath)
}
try {
    & .\gradlew.bat @gradleArguments 2>&1 | Tee-Object -FilePath "$env:TEMP\gradle-build.log" | Select-Object -Last 10
    $gradleExit = $LASTEXITCODE
}
finally {
    if ($previewVersionInitScriptPath -and (Test-Path -LiteralPath $previewVersionInitScriptPath)) {
        Remove-Item -LiteralPath $previewVersionInitScriptPath -Force
    }
}
Set-Location "$REPO_DIR"

if ($gradleExit -ne 0) {
    Write-Error "gradle build failed (exit $gradleExit). Log: $env:TEMP\gradle-build.log"
    exit 1
}
Write-Host "  BUILD SUCCESSFUL  OK"

# --- Step 4: Sign APK ---
Write-Host ""
Write-Host "[4/7] Signing APK..."
$apkPath = "$REPO_DIR\android\app\build\outputs\apk\release\app-release.apk"
& $apksigner.FullName sign --ks "$REPO_DIR\android\app\debug.keystore" --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android $apkPath *>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "apksigner failed (exit $LASTEXITCODE)"; exit 1 }

# Verify signature
$verifyOutput = (& $apksigner.FullName verify --verbose $apkPath 2>&1) -join "`n"
if (-not $verifyOutput.Contains("Verifies")) { Write-Error "Signature verification failed"; exit 1 }
Write-Host "  Signed (v2/v3)  OK"

# Verify version in APK
$badging = (& $aapt.FullName dump badging $apkPath 2>&1) -join "`n"
if ($badging -match "package: name='[^']*' versionCode='(\d+)' versionName='([^']+)'") {
    $apkVc = $Matches[1]; $apkVn = $Matches[2]
    if ($apkVc -ne $expectedApkVersionCode -or $apkVn -ne $Version) {
        Write-Error "APK version mismatch: got versionCode=$apkVc versionName=$apkVn, expected $expectedApkVersionCode/$Version"
        Write-Host "  The build.gradle bump may not have been picked up. Try -Clean." -ForegroundColor Yellow
        exit 1
    }
    Write-Host "  APK version: $apkVn (code=$apkVc)  OK"
}

New-Item -ItemType Directory -Force -Path $DIST_DIR | Out-Null
Copy-Item $apkPath $APK_PATH -Force
$apkSize = [math]::Round((Get-Item $APK_PATH).Length / 1MB, 1)
Write-Host ("  {0} ({1:N1} MB)  OK" -f $APK_NAME, $apkSize)

if ($BuildOnly) {
    Write-Host ""
    Write-Host "  Build complete (-BuildOnly)" -ForegroundColor Cyan
    Write-Host "  APK: $APK_PATH" -ForegroundColor Cyan
    exit 0
}

# --- Step 5: Commit and push ---
Write-Host ""
Write-Host "[5/7] Committing and pushing to $Branch..."

Assert-NoUntrackedFiles
Assert-OnlyReleaseVersionChanges

git add -- app.json android/app/build.gradle
$staged = git diff --cached --stat 2>&1
if ([string]::IsNullOrWhiteSpace($staged)) {
    Write-Error "Release blocked: no version-file changes were staged for commit. A release version bump should create a commit."
    exit 1
}

$commitMsg = if ($Message) { "$TAG" + ": " + $Message } else { "Bump version to $Version" }
$commitOutput = git -c user.name=$GIT_AUTHOR -c user.email=$GIT_EMAIL commit -m $commitMsg 2>&1
$commitExit = $LASTEXITCODE
$commitOutput | Select-Object -First 3
if ($commitExit -ne 0) {
    Write-Error "Release blocked: git commit failed. GitHub release creation and APK upload were not attempted."
    exit 1
}
Write-Host "  Committed  OK"

$pushOutput = git push origin $Branch 2>&1
$pushExit = $LASTEXITCODE
$pushOutput | Select-Object -First 3
if ($pushExit -ne 0) {
    Write-Error "Release blocked: git push to origin/$Branch failed. GitHub release creation and APK upload were not attempted."
    exit 1
}
Write-Host "  Pushed to origin/$Branch  OK"

# --- Step 6: Create GitHub release ---
Write-Host ""
Write-Host "[6/7] Creating GitHub release $TAG..."

$credInput = "protocol=https`nhost=github.com`n"
$credRaw = $credInput | git credential fill 2>&1
$token = ($credRaw | Select-String "^password=" | ForEach-Object { $_ -replace "^password=", "" })
if (-not $token) {
    Write-Host "  Could not get GitHub token from credential helper" -ForegroundColor Red
    Write-Host "  APK is at: $APK_PATH" -ForegroundColor Yellow
    exit 1
}

# Check if release already exists
$checkResult = curl.exe -s -o NUL -w "%{http_code}" -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/tags/$TAG" 2>&1
if ($checkResult -eq "200") {
    Write-Host "  Release $TAG already exists -- uploading APK only..." -ForegroundColor Yellow
    $relJson = curl.exe -s -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/releases/tags/$TAG" 2>&1
    $rel = $relJson | ConvertFrom-Json
    $releaseId = $rel.id
} else {
    $releaseNotes = "## $APP_NAME $TAG`n`n### Installation`n1. Download the APK below`n2. Transfer to your Android device`n3. Enable Install from Unknown Sources if prompted`n4. Install and open`n5. Long-press home screen, Widgets, TubePulse"
    $bodyObj = @{ tag_name = $TAG; name = "$APP_NAME $TAG"; body = $releaseNotes; draft = $false; prerelease = $false; make_latest = "true" }
    $bodyJson = $bodyObj | ConvertTo-Json -Compress
    $bodyJson | Out-File -FilePath "$env:TEMP\release-body.json" -Encoding ascii -NoNewline

    $createResult = curl.exe -s -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" -d "@$env:TEMP\release-body.json" "https://api.github.com/repos/$REPO/releases" 2>&1
    $rel = $createResult | ConvertFrom-Json
    if (-not $rel.id) {
        Write-Host "  Release creation failed: $($rel.message)" -ForegroundColor Red
        Write-Host "  APK is at: $APK_PATH" -ForegroundColor Yellow
        exit 1
    }
    $releaseId = $rel.id
    Write-Host "  Release created (ID: $releaseId)  OK"
}

# --- Step 7: Upload APK ---
Write-Host ""
Write-Host "[7/7] Uploading APK..."
$uploadResult = curl.exe -s -X POST -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" -H "Content-Type: application/vnd.android.package-archive" --data-binary "@$APK_PATH" "https://uploads.github.com/repos/$REPO/releases/$releaseId/assets?name=$APK_NAME" 2>&1
$asset = $uploadResult | ConvertFrom-Json
if ($asset.browser_download_url) {
    Write-Host "  APK uploaded  OK"
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "  Release $TAG is live!" -ForegroundColor Cyan
    Write-Host "  $($asset.browser_download_url)" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
} else {
    Write-Host "  Upload failed: $($asset.message)" -ForegroundColor Red
    Write-Host "  APK is at: $APK_PATH" -ForegroundColor Yellow
    exit 1
}

Remove-Item "$env:TEMP\release-body.json" -ErrorAction SilentlyContinue
