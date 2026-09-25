# Runs transport-bench.mjs across transports and clumsy network conditions.
# Needs an elevated shell (clumsy loads WinDivert). Results append to
# ~/.pocketdesk/bench/results.jsonl, one JSON line per run.
#   powershell -ExecutionPolicy Bypass -File scripts\transport-bench-matrix.ps1 -Clumsy C:\path\clumsy.exe -Relay C:\path\iroh-relay.exe
param(
    [Parameter(Mandatory)] [string] $Clumsy,
    [string] $Relay = "",
    [int] $Secs = 30,
    [int] $Repeats = 2
)
$ErrorActionPreference = "Stop"
$bench = Join-Path $PSScriptRoot "transport-bench.mjs"
$outDir = Join-Path $env:USERPROFILE ".pocketdesk\bench"
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = Join-Path $outDir "results.jsonl"
$errLog = Join-Path $outDir "errors.log"
if (-not $env:FFMPEG_PATH) { $env:FFMPEG_PATH = (Get-Command ffmpeg).Source }

# clumsy sees each loopback packet twice (send and receive), so every
# probability and delay is set to half of the intended effective value.
$conditions = @(
    @{ name = "clean";       args = @() },
    @{ name = "loss1";       args = @("--drop", "on", "--drop-chance", "0.5") },
    @{ name = "loss3";       args = @("--drop", "on", "--drop-chance", "1.5") },
    @{ name = "loss5";       args = @("--drop", "on", "--drop-chance", "2.5") },
    @{ name = "lag50";       args = @("--lag", "on", "--lag-time", "25") },
    @{ name = "lag50+loss3"; args = @("--lag", "on", "--lag-time", "25", "--drop", "on", "--drop-chance", "1.5") },
    @{ name = "cap500KBps";  args = @("--bandwidth", "on", "--bandwidth-bandwidth", "500") }
)
$transports = @(
    @{ name = "ws";          args = @("--transport", "ws");          filter = "tcp and loopback" },
    @{ name = "iroh-single"; args = @("--transport", "iroh-single"); filter = "udp and loopback" },
    @{ name = "iroh-gop60";  args = @("--transport", "iroh-gop", "--gop", "60"); filter = "udp and loopback" },
    @{ name = "iroh-gop30";  args = @("--transport", "iroh-gop", "--gop", "30"); filter = "udp and loopback" }
)

function Invoke-Run($label, $cond, $filter, $benchArgs) {
    $proc = $null
    if ($cond.args.Count -gt 0) {
        $proc = Start-Process $Clumsy -ArgumentList (@("--filter", "`"$filter`"") + $cond.args) -PassThru
        Start-Sleep -Seconds 2
    }
    try {
        # A failed run is logged and skipped; one bad run must not end the matrix.
        $raw = & cmd /c "node `"$bench`" $($benchArgs -join ' ') --secs $Secs 2>&1"
        $line = $raw | Where-Object { $_ -like '{*' } | Select-Object -Last 1
        if (-not $line) {
            Add-Content -Encoding utf8 $errLog "[$label $($cond.name)] $($raw -join "`n")"
            Write-Host "$label $($cond.name): FAILED (see errors.log)"
            return
        }
        $obj = $line | ConvertFrom-Json
        $obj | Add-Member -NotePropertyName condition -NotePropertyValue $cond.name
        $obj | Add-Member -NotePropertyName label -NotePropertyValue $label
        ($obj | ConvertTo-Json -Compress) | Add-Content -Encoding utf8 $out
        Write-Host "$label $($cond.name): fps=$($obj.fps) p50=$($obj.latP50) p95=$($obj.latP95) stalls=$($obj.stalls) stallMs=$($obj.stallMs)"
    } catch {
        Add-Content -Encoding utf8 $errLog "[$label $($cond.name)] $_"
    } finally {
        if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
    }
}

for ($r = 1; $r -le $Repeats; $r++) {
    foreach ($t in $transports) {
        foreach ($c in $conditions) { Invoke-Run $t.name $c $t.filter $t.args }
    }
    # Relayed: loopback UDP fully dropped so no direct path can form; the relay leg is TCP.
    $block = @{ name = "relay-forced"; args = @("--drop", "on", "--drop-chance", "100") }
    if ($Relay) {
        $relayProc = Start-Process $Relay -ArgumentList "--dev" -PassThru -WindowStyle Hidden
        Start-Sleep -Seconds 2
        try { Invoke-Run "iroh-gop60-relay-local" $block "udp and loopback" @("--transport", "iroh-gop", "--relay", "http://localhost:3340") }
        finally { Stop-Process -Id $relayProc.Id -Force -ErrorAction SilentlyContinue }
    }
    Invoke-Run "iroh-gop60-relay-n0" $block "udp and loopback" @("--transport", "iroh-gop", "--relay", "n0")
}
Write-Host "done: $out"
