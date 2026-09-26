# Builds PocketDesk-Setup.exe: a double-click wrapper around install.ps1, made with Windows' own IExpress.
#
#   powershell -ExecutionPolicy Bypass -File daemon\scripts\build-setup.ps1 [-Out PocketDesk-Setup.exe]

param([string]$Out = "PocketDesk-Setup.exe")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
$work = Join-Path $env:TEMP ("rh-setup-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $work | Out-Null
try {
    Copy-Item (Join-Path $root "install.ps1") $work
    # Keeps the window open on failure so the error can be read.
    Set-Content -Encoding ASCII (Join-Path $work "setup.cmd") @'
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (echo. & echo Setup failed. & pause)
'@
    Set-Content -Encoding ASCII (Join-Path $work "setup.sed") @"
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
TargetName=$Out
FriendlyName=PocketDesk Setup
AppLaunched=cmd /c setup.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="install.ps1"
FILE1="setup.cmd"
[SourceFiles]
SourceFiles0=$work\
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
    & "$env:WINDIR\System32\iexpress.exe" /N /Q (Join-Path $work "setup.sed") | Out-Null
    for ($i = 0; $i -lt 60 -and -not (Test-Path $Out); $i++) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Path $Out)) { throw "IExpress did not produce $Out" }
    Write-Host "built $Out"
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
