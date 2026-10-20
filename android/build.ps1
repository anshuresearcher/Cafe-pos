$ErrorActionPreference = "Stop"

if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
    $jdkRoot = Join-Path $env:ProgramFiles "Java"
    $jdk = Get-ChildItem -LiteralPath $jdkRoot -Directory -Filter "jdk*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if (-not $jdk) {
        throw "Install a Java 17 or newer JDK, then set JAVA_HOME before building the Android APK."
    }
    $env:JAVA_HOME = $jdk.FullName
}

$sdkCandidates = @(
    $env:ANDROID_HOME,
    $env:ANDROID_SDK_ROOT,
    (Join-Path $env:LOCALAPPDATA "Android\Sdk")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $sdkCandidates) {
    throw "Android SDK was not found. Install Android SDK Platform 36 and set ANDROID_HOME."
}

$env:ANDROID_HOME = $sdkCandidates[0]
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = Join-Path $PSScriptRoot ".android-user"
$env:GRADLE_USER_HOME = Join-Path $PSScriptRoot ".gradle-user"
$env:Path = "$($env:JAVA_HOME)\bin;$($env:ANDROID_HOME)\platform-tools;$($env:Path)"

& (Join-Path $PSScriptRoot "gradlew.bat") -p $PSScriptRoot assembleDebug
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "APK created at android/app/build/outputs/apk/debug/app-debug.apk"
