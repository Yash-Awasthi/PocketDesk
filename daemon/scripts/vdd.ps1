# SPDX-License-Identifier: GPL-3.0-or-later
# A virtual monitor at the phone's size, for using the phone or tablet as an extra screen.
# Installs the Virtual Display Driver (MIT, github.com/VirtualDrivers/Virtual-Display-Driver)
# the first time, the way its own silent-install.ps1 does, then sets the resolution and reloads it.
# Runs elevated; -Off turns the monitor off again. Exit code 0 on success.
param(
    [int]$Width = 0,
    [int]$Height = 0,
    [switch]$Off
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$log = Join-Path $env:TEMP "pocketdesk-vdd.log"
function Say($t) { "$(Get-Date -Format T) $t" | Out-File -Append $log }

try {
    $dev = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains "Root\MttVDD" } | Select-Object -First 1
    if ($Off) {
        if ($dev) { Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false }
        exit 0
    }
    if (-not $dev) {
        Say "installing the Virtual Display Driver"
        $tmp = Join-Path $env:TEMP "pocketdesk-vdd"
        New-Item -ItemType Directory -Force $tmp | Out-Null
        Invoke-WebRequest -UseBasicParsing "https://github.com/nefarius/nefcon/releases/download/v1.14.0/nefcon_v1.14.0.zip" -OutFile "$tmp\nefcon.zip"
        Expand-Archive "$tmp\nefcon.zip" $tmp -Force
        Invoke-WebRequest -UseBasicParsing "https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip" -OutFile "$tmp\driver.zip"
        Expand-Archive "$tmp\driver.zip" $tmp -Force
        # The driver is signed through SignPath; its certificates go in TrustedPublisher so it installs without a prompt.
        $certs = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
        $certs.Import([System.IO.File]::ReadAllBytes((Join-Path $tmp "VirtualDisplayDriver\mttvdd.cat")))
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("TrustedPublisher", "LocalMachine")
        $store.Open("ReadWrite")
        foreach ($c in $certs) { $store.Add($c) }
        $store.Close()
        & (Join-Path $tmp "x64\nefconw.exe") install (Join-Path $tmp "VirtualDisplayDriver\MttVDD.inf") "Root\MttVDD"
        Start-Sleep -Seconds 8
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        $dev = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains "Root\MttVDD" } | Select-Object -First 1
        if (-not $dev) { throw "the driver did not install" }
    }
    $file = "C:\VirtualDisplayDriver\vdd_settings.xml"
    # The driver alone ships no settings file; without one it offers only its built-in modes.
    if (-not (Test-Path $file)) {
        New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
        $modes = @(@(1280, 720), @(1920, 1080), @(2560, 1440), @(3840, 2160)) | ForEach-Object { "    <resolution><width>$($_[0])</width><height>$($_[1])</height><refresh_rate>60</refresh_rate></resolution>" }
        @"
<?xml version='1.0' encoding='utf-8'?>
<vdd_settings>
  <monitors><count>1</count></monitors>
  <gpu><friendlyname>default</friendlyname></gpu>
  <global><g_refresh_rate>60</g_refresh_rate></global>
  <resolutions>
$($modes -join "`n")
  </resolutions>
</vdd_settings>
"@ | Set-Content -Encoding UTF8 $file
    }
    if ($Width -gt 0 -and $Height -gt 0) {
        [xml]$x = Get-Content -Raw $file
        $x.vdd_settings.monitors.count = "1"
        $res = $x.vdd_settings.resolutions
        $have = @($res.resolution | Where-Object { [int]$_.width -eq $Width -and [int]$_.height -eq $Height })
        if (-not $have) {
            $r = $x.CreateElement("resolution")
            foreach ($kv in @(@("width", $Width), @("height", $Height), @("refresh_rate", 60))) {
                $e = $x.CreateElement($kv[0]); $e.InnerText = "$($kv[1])"; [void]$r.AppendChild($e)
            }
            # First in the list: the mode Windows picks for a new monitor.
            [void]$res.PrependChild($r)
        }
        $x.Save($file)
    }
    # A reload applies the new resolution and turns the monitor on if it was off.
    Disable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false
    Start-Sleep -Seconds 1
    Enable-PnpDevice -InstanceId $dev.InstanceId -Confirm:$false
    Start-Sleep -Seconds 3
    # Windows starts a new monitor at a mode of its choosing; switch it to the phone's.
    if ($Width -gt 0 -and $Height -gt 0) {
        Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class PdDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct DD { public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Name; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Str; public int Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Id; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Key; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct DM { [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Name; public short SpecV, DrvV, Size, DrvExtra; public int Fields, X, Y, Orient, Fixed; public short Color, Duplex, YRes, TT, Collate; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string Form; public short LogPx; public int Bpp, W, H, DFlags, Freq, ICM1, ICM2, ICM3, ICM4, Res1, Res2, PW, PH; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, int i, ref DD dd, int f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int i, ref DM dm);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, ref DM dm, IntPtr hwnd, int flags, IntPtr param);
  public static int Set(int w, int h) {
    var d = new DD(); d.cb = Marshal.SizeOf(d);
    for (int i = 0; EnumDisplayDevices(null, i, ref d, 0); i++, d.cb = Marshal.SizeOf(d)) {
      if (d.Id == null || d.Id.IndexOf("MttVDD", StringComparison.OrdinalIgnoreCase) < 0) continue;
      var m = new DM(); m.Size = (short)Marshal.SizeOf(m);
      for (int k = 0; EnumDisplaySettings(d.Name, k, ref m); k++) {
        if (m.W != w || m.H != h) continue;
        m.Fields = 0x80000 | 0x100000; // DM_PELSWIDTH | DM_PELSHEIGHT
        return ChangeDisplaySettingsEx(d.Name, ref m, IntPtr.Zero, 0x1, IntPtr.Zero); // CDS_UPDATEREGISTRY
      }
      return -100;
    }
    return -101;
  }
}
'@
        $r = [PdDisplay]::Set($Width, $Height)
        Say "set mode ${Width}x${Height}: $r"
    }
    Say "monitor ready at ${Width}x${Height}"
    exit 0
} catch {
    Say "failed: $($_.Exception.Message)"
    exit 1
}
