# Builds PocketDesk-Install.exe and PocketDesk-Uninstall.exe: double-click wrappers around install.ps1 and
# uninstall.ps1, made with Windows' own IExpress. Settings > Apps runs the installed uninstall.ps1 as well.
#
#   powershell -ExecutionPolicy Bypass -File daemon\scripts\build-setup.ps1 [-OutDir .]

param([string]$OutDir = ".")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$OutDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutDir)
New-Item -ItemType Directory -Force $OutDir | Out-Null

function Pack($exeName, $friendly, $script, $cmd) {
    $out = Join-Path $OutDir $exeName
    $work = Join-Path $env:TEMP ("rh-pack-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $work | Out-Null
    try {
        Copy-Item (Join-Path $root $script) $work
        Set-Content -Encoding ASCII (Join-Path $work "run.cmd") $cmd
        Set-Content -Encoding ASCII (Join-Path $work "pack.sed") @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$out
FriendlyName=$friendly
AppLaunched=cmd /c run.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="$script"
FILE1="run.cmd"
[SourceFiles]
SourceFiles0=$work\
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
        if (Test-Path $out) { Remove-Item $out }
        & "$env:WINDIR\System32\iexpress.exe" /N /Q (Join-Path $work "pack.sed") | Out-Null
        for ($i = 0; $i -lt 60 -and -not (Test-Path $out); $i++) { Start-Sleep -Milliseconds 500 }
        if (-not (Test-Path $out)) { throw "IExpress did not produce $out" }
        Write-Host "built $out"
    } finally {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
}

# The window stays open only on failure, so a normal run is a single double-click.
Pack "PocketDesk-Install.exe" "PocketDesk Install" "install.ps1" @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (echo. & echo Setup failed. & pause)
'@
Pack "PocketDesk-Uninstall.exe" "PocketDesk Uninstall" "uninstall.ps1" @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
if errorlevel 1 (echo. & echo Uninstall failed. & pause)
'@
