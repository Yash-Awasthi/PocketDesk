# Start-menu entry when Smart App Control blocks the compiled launcher: starts the daemon task if
# needed, then opens the pairing page. The token goes to the browser only after the listener proves
# it holds this PC's certificate, so a program squatting on the port cannot collect it.
$ErrorActionPreference = "Stop"
$cfg = Get-Content (Join-Path $env:USERPROFILE ".pocketdesk\config.json") -Raw | ConvertFrom-Json
$port = [int]$cfg.port
$listening = { Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue }
if (-not (& $listening)) {
    Start-ScheduledTask -TaskName "PocketDesk"
    for ($i = 0; $i -lt 30 -and -not (& $listening); $i++) { Start-Sleep -Seconds 1 }
}
$scheme = "http"
if ($cfg.tls.enabled) {
    $scheme = "https"
    $want = (New-Object Security.Cryptography.X509Certificates.X509Certificate2 $cfg.tls.cert).Thumbprint
    $script:seen = $null
    $tcp = New-Object Net.Sockets.TcpClient("127.0.0.1", $port)
    $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, { param($s, $cert) $script:seen = $cert.GetCertHashString(); $true })
    try { $ssl.AuthenticateAsClient("localhost") } finally { $ssl.Dispose(); $tcp.Close() }
    if ($script:seen -ne $want) { throw "port $port is not this PC's PocketDesk" }
}
Start-Process ("{0}://localhost:{1}/pair?k={2}" -f $scheme, $port, $cfg.token)
