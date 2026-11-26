# Lab recipe: set policy, verify, hand the machine over

Use this before an exam or any supervised session on a shared PC. Set the four machine policy keys
so the features the session does not need are refused, verify the result with one read-only command,
and then hand the machine to the candidate.

## The keys and the two stores

| Key                | Gates                                                          |
| ------------------ | -------------------------------------------------------------- |
| AllowRemoteControl | Remote desktop control: desktop_start, remote_input, kvm input |
| AllowWebcam        | The PocketDesk virtual webcam (adb_webcam)                     |
| AllowPhoneControl  | Driving a phone over adb (input, apps, files, pairing)         |
| AllowClipboard     | Clipboard sync, file paste and handoff                         |

There are two stores. The registry key is `HKLM\SOFTWARE\PocketDesk\Policy`; the console's copy is
`C:\ProgramData\PocketDesk\policy.json`. A key set to `0` in either store disables its feature, and
the stricter store wins, so a `1` in the other store does not turn it back on. A key that is not set
at all means the feature is on, so a machine with no policy behaves exactly as before.

## Read the policy (no admin needed)

Run this from the `daemon` folder. Reads work in an ordinary shell.

```powershell
node src/cli.js policy --status
```

Output:

```
AllowRemoteControl: on (not set)
AllowWebcam: on (not set)
AllowPhoneControl: on (not set)
AllowClipboard: on (not set)
```

`EXIT=0`. The bare form `node src/cli.js policy` prints the same four lines and also exits 0.

A stray argument is refused rather than ignored:

```powershell
node src/cli.js policy --status extra
```

Output:

```
pocketdesk policy [--status | set KEY 0|1 | reset [KEY|all]]
```

`EXIT=1`.

## Turn a feature off

Needs an admin shell (PowerShell as administrator). Run these real-store lines from `daemon/`.

```powershell
node src/cli.js policy set AllowRemoteControl 0
node src/cli.js policy set AllowWebcam 0
node src/cli.js policy set AllowPhoneControl 0
node src/cli.js policy set AllowClipboard 0
```

To turn one feature back on, use 1:

```powershell
node src/cli.js policy set AllowWebcam 1
```

Each write updates both stores. These lines were not run in this session, because it had no elevated
shell.

## Re-verify with --status

Run the same read command again from `daemon/`:

```powershell
node src/cli.js policy --status
```

On the real store, a key that was set to 0 reads like this (this is the shape `describe()` prints;
it was not produced here because that needs an elevated write):

```
AllowWebcam: OFF (set to 0 in HKLM (HKLM\SOFTWARE\PocketDesk\Policy))
```

When the 0 is in the JSON copy, the line names the file instead. This one was captured from the test
store (see the last section):

```
AllowWebcam: OFF (set to 0 in C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json)
```

`describe()` labels the registry source with an `HKLM` prefix whatever the registry path is, which is
why the JSON test store's registry lines below read `HKLM (HKCU\...)`.

## What the phone sees

The request is refused, and the reason travels back as one line:

`disabled_by_policy: AllowWebcam is 0 in <store>; adb_webcam is refused`

The phone shows that error text, where `<store>` is the registry label or the JSON path that holds
the 0, and the daemon logs the refusal. A captured instance from the test store:

```
disabled_by_policy: AllowWebcam is 0 in C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json; adb_webcam is refused
```

## Reset

Needs an admin shell (PowerShell as administrator). To clear one key, run this from `daemon/`:

```powershell
node src/cli.js policy reset AllowClipboard
```

To clear every key:

```powershell
node src/cli.js policy reset all
```

Reset removes the value from both stores, so the feature is on again. These lines were not run in
this session, because it had no elevated shell.

## Test-store variant

This section is the test-store variant, not the real machine policy. It points both stores at
scratch locations so the commands can be exercised without an admin shell:

```powershell
$env:RH_POLICY_JSON = "$env:TEMP\pocketdesk-lab-policy.json"
$env:RH_POLICY_REG = "HKCU\SOFTWARE\PocketDesk\PolicyLabTest"
```

All commands below ran from `daemon/` with those two variables set. A plain set is still refused,
because the admin probe is the real one:

```powershell
node src/cli.js policy set AllowWebcam 0
```

Output:

```
policy: changing machine policy needs an elevated shell: open PowerShell as administrator and run it again; nothing was written
```

`EXIT=1`.

The writes below force the admin probe on, which is the same seam the unit test uses. One command per
key:

```powershell
node --input-type=module -e "const {runPolicy}=await import('./src/policy_cli.js'); console.log(runPolicy(['set','AllowRemoteControl','0'],{admin:true}).out.join('\n'))"
```

Output:

```
policy: AllowRemoteControl=0 written
HKCU\SOFTWARE\PocketDesk\PolicyLabTest\AllowRemoteControl=0
C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json: AllowRemoteControl=0
```

```powershell
node --input-type=module -e "const {runPolicy}=await import('./src/policy_cli.js'); console.log(runPolicy(['set','AllowWebcam','0'],{admin:true}).out.join('\n'))"
```

Output:

```
policy: AllowWebcam=0 written
HKCU\SOFTWARE\PocketDesk\PolicyLabTest\AllowWebcam=0
C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json: AllowWebcam=0
```

```powershell
node --input-type=module -e "const {runPolicy}=await import('./src/policy_cli.js'); console.log(runPolicy(['set','AllowPhoneControl','0'],{admin:true}).out.join('\n'))"
```

Output:

```
policy: AllowPhoneControl=0 written
HKCU\SOFTWARE\PocketDesk\PolicyLabTest\AllowPhoneControl=0
C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json: AllowPhoneControl=0
```

```powershell
node --input-type=module -e "const {runPolicy}=await import('./src/policy_cli.js'); console.log(runPolicy(['set','AllowClipboard','0'],{admin:true}).out.join('\n'))"
```

Output:

```
policy: AllowClipboard=0 written
HKCU\SOFTWARE\PocketDesk\PolicyLabTest\AllowClipboard=0
C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json: AllowClipboard=0
```

The read command shows the four OFF lines. This is the test-store variant; the store names are the
scratch registry key and the temp file, not the real policy:

```powershell
node src/cli.js policy --status
```

Output:

```
AllowRemoteControl: OFF (set to 0 in HKLM (HKCU\SOFTWARE\PocketDesk\PolicyLabTest))
AllowWebcam: OFF (set to 0 in HKLM (HKCU\SOFTWARE\PocketDesk\PolicyLabTest))
AllowPhoneControl: OFF (set to 0 in HKLM (HKCU\SOFTWARE\PocketDesk\PolicyLabTest))
AllowClipboard: OFF (set to 0 in HKLM (HKCU\SOFTWARE\PocketDesk\PolicyLabTest))
```

`EXIT=0`.

To see the JSON store named as the source, the scratch registry key can be deleted and the status
read again. Still the test-store variant:

```powershell
reg delete "HKCU\SOFTWARE\PocketDesk\PolicyLabTest" /f
node src/cli.js policy --status
```

Output:

```
The operation completed successfully.
AllowRemoteControl: OFF (set to 0 in C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json)
AllowWebcam: OFF (set to 0 in C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json)
AllowPhoneControl: OFF (set to 0 in C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json)
AllowClipboard: OFF (set to 0 in C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json)
```

`EXIT=0`.

The reset one-liners, still with the admin probe forced on:

```powershell
node --input-type=module -e "const {runPolicy}=await import('./src/policy_cli.js'); console.log(runPolicy(['reset','AllowClipboard'],{admin:true}).out.join('\n'))"
```

Output:

```
policy: AllowClipboard reset
C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json: AllowClipboard cleared
```

```powershell
node --input-type=module -e "const {runPolicy}=await import('./src/policy_cli.js'); console.log(runPolicy(['reset','all'],{admin:true}).out.join('\n'))"
```

Output:

```
policy: every key reset
C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json: AllowRemoteControl, AllowWebcam, AllowPhoneControl, AllowClipboard cleared
```

A read after the reset shows every key on again:

```powershell
node src/cli.js policy --status
```

Output:

```
AllowRemoteControl: on (not set)
AllowWebcam: on (not set)
AllowPhoneControl: on (not set)
AllowClipboard: on (not set)
```

`EXIT=0`.

The refusal line in the previous section was produced the same way, with the scratch JSON store at
`AllowWebcam: 0`:

```powershell
Set-Content -Path $env:RH_POLICY_JSON -Value '{"AllowWebcam":0}' -Encoding ascii
node --input-type=module -e "const {refusalFor}=await import('./src/policy.js'); console.log(refusalFor('adb_webcam').message)"
```

Output:

```
disabled_by_policy: AllowWebcam is 0 in C:\Users\Yash\AppData\Local\Temp\pocketdesk-lab-policy.json; adb_webcam is refused
```

## Summary

Reads need no elevation; writes do. The real-store set and reset commands in this recipe were not
run here because this session had no elevated shell. The test-store variant above is what was
actually run, against a scratch registry key and a temp JSON file.
