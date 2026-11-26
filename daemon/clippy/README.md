# clippy

Minimalistic native Windows recorder for text that never reaches the clipboard.
A low-level keyboard hook rebuilds what is typed (backspace, Enter and Tab
applied) and rewrites the latest snapshot on `Ctrl+C`. Built to recover text
typed into apps that swallow the clipboard, such as a game with its own copy
handling. Single ~16 KB exe, no runtime to install. Visible, named process and
Scheduled Task; not hidden.

## Files it writes

Both live in its data folder (beside the exe, or the path in `clippy_dir.txt`,
or `%LOCALAPPDATA%\PocketDesk\clippy` when the install is read-only):

- `clippy_capture.json` — **overwritten** on every capture: the latest snapshot
  (foreground window, system clipboard text, and the typed buffer since the
  previous `Ctrl+C`).
- `clippy_history.json` — **rewritten** on every capture, one JSON object per
  line: the last 20 captures, newest last.

## Build

No external toolchain needed — uses the C# compiler built into Windows:

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /optimize+ /out:clippy.exe /r:System.Windows.Forms.dll clippy.cs
```

## Use

Self-managing single binary:

```
clippy --install     register the on-demand elevated task "Clippy" (one UAC prompt)
clippy --uninstall   remove the task
clippy --start       start recording
clippy --stop        stop recording
clippy --open        open the latest capture
clippy --clear       empty the capture and the history
clippy --dir <path>  write there instead (also CLIPPY_DIR); the task bakes it in
clippy               run the recorder directly
```

The task runs at the interactive session, highest run level, so the hook sees
keystrokes in elevated windows too. Off by default; start/stop from PocketDesk
or on demand.

## Keys (while running)

- `Ctrl+Shift+Q` — stop
- `Ctrl+Shift+X` — clear the buffer, keep recording
- `Ctrl+C` — write the snapshot (latest) and append to the history; the typed
  buffer then starts empty, so the next capture holds only what followed

Paste is not captured; typing, backspace, Enter and Tab are. Keys synthesised by
another program (PocketDesk pasting, for example) are ignored, so the buffer only
holds what the user typed. `Ctrl+Alt` combinations (AltGr) type normally.

## Notes

Linear buffer: backspace removes the last character; mid-text edits via arrows or
mouse are not tracked. Captures everything typed system-wide while running.
