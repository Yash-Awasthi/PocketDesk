// How a window is read, and what to say when it cannot be.
//
// The ids and the order here are the ones that were measured, not the ones that
// sound plausible. Every rung was run against a window with the protection flag
// set and again with the gate in place, on a plain GDI window and on a window
// composited by Direct3D:
//
//   PrintWindow      black when protected, 0 differing pixels once gated
//   screen BitBlt    black when protected, 0 differing pixels once gated
//   DXGI             desktop frame when protected, window present once gated
//   window DC        black when protected, 6.8-8.5% off once gated
//
// The window-DC method is therefore absent: it was measured and it is wrong.
// A method that reads nothing is not offered as a fallback either, because a
// fallback that silently returns black is worse than a named refusal.

/** Preferred first. `printwindow` leads because it asks the window to paint
 *  itself, so an overlay, a notification or the taskbar cannot leak into the
 *  frame, which a screen grab cannot promise. */
export const MODE_IDS = ["printwindow", "screen", "dxgi", "fullscreen"];

const LABELS = {
  auto: "Automatic",
  printwindow: "Window render",
  screen: "Screen grab",
  dxgi: "DirectX grab",
  fullscreen: "Fullscreen fix",
};

const NOTES = {
  printwindow: "asks the window to paint itself; an overlay cannot appear in the frame",
  screen: "reads the screen rectangle; the window has to be in front",
  dxgi: "reads a whole display; for a window that never reaches the compositor",
  fullscreen: "changes the display mode so an exclusive window becomes capturable",
};

/** The rungs to try, in order. An explicit mode is one rung unless it is
 *  `auto`, and `auto` always ends with the display-mode change because that is
 *  the only rung that costs the user anything visible. */
export function orderFor(requested = "auto") {
  if (!requested || requested === "auto") {
    return MODE_IDS.filter((m) => m !== "fullscreen").concat(["fullscreen"]);
  }
  if (!MODE_IDS.includes(requested)) throw new Error(`unknown capture mode: ${requested}`);
  return [requested];
}

/** What the phone shows: every rung, with the label and the reason it exists. */
export function describeModes(current = "auto") {
  return [
    {
      id: "auto",
      label: LABELS.auto,
      note: "try each method until one returns the window",
      current: current === "auto",
    },
    ...MODE_IDS.map((id) => ({
      id,
      label: LABELS[id],
      note: NOTES[id],
      current: current === id,
    })),
  ];
}

/** Every refusal names a cause, and every cause names a different next step, so
 *  "it did not work" never reaches the user. `code` is what the helper returned. */
export function classifyCause(code, detail = "") {
  const text = String(detail || "");
  switch (code) {
    case "needs_elevation":
      return {
        id: "needs_elevation",
        say: "The game runs at a higher privilege than the capture helper.",
        next: "Restart the helper elevated and try again; nothing else is wrong.",
      };
    case "protected_process":
      return {
        id: "protected_process",
        say: "The game protects its own process, so nothing outside it can read its memory.",
        next: "No capture method can help. This is a hard stop, not a setting.",
      };
    case "architecture_mismatch":
      return {
        id: "architecture_mismatch",
        say: "The helper and the game are different widths, and a wrong-width patch would crash the game.",
        next: "Use the helper build that matches the game's width.",
      };
    case "unsupported_export":
      return {
        id: "unsupported_export",
        say: "This Windows build does not expose the call in a form that can be redirected.",
        next: "Fall back to the DirectX grab, which does not touch the game.",
      };
    case "no_window":
      return {
        id: "no_window",
        say: "No window belonging to that process is open.",
        next: "Start the game, or pick the window from the list.",
      };
    case "exclusive_fullscreen":
      return {
        id: "exclusive_fullscreen",
        say: "The window draws straight to the display and never reaches the desktop picture.",
        next: "Use the DirectX grab, or the fullscreen fix to make it a window.",
      };
    default:
      return {
        id: "unknown",
        say: text || "The capture returned nothing usable.",
        next: "Run the check to see which method fails.",
      };
  }
}

/** The three-step comparison, turned into one verdict line.
 *  `control` is the capture with no gate: it must NOT be the window.
 *  `gated` is the capture with the gate: it must be the window.
 *  `reverse` is the capture after the gate is removed: it must be the control
 *  again, and it is what proves the gate caused the change. */
export function verdict({ controlPct, gatedPct, reversePct, width, height, expectedWidth, expectedHeight }) {
  const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

  if (!(expectedWidth > 0) || !(expectedHeight > 0)) {
    return { ok: false, line: "The check did not run: the window has no size." };
  }
  if (!near(width, expectedWidth, 0) || !near(height, expectedHeight, 0)) {
    return {
      ok: false,
      line: `The capture is ${width}x${height} and the window is ${expectedWidth}x${expectedHeight}: scaled or cropped.`,
    };
  }
  if (!(controlPct > 50)) {
    return {
      ok: false,
      line: `Without the gate the capture already looks like the window (${controlPct.toFixed(2)}% different). The window is not hiding from recorders, so this proves nothing.`,
    };
  }
  if (!(gatedPct <= 0.5)) {
    return {
      ok: false,
      line: `With the gate ${gatedPct.toFixed(2)}% of pixels still differ: the frame is not the window's own.`,
    };
  }
  if (!(reversePct > 50)) {
    return {
      ok: false,
      line: `After the gate was removed the capture still matched (${reversePct.toFixed(2)}% different), so something else is hiding the window.`,
    };
  }
  return {
    ok: true,
    line: `Full ${width}x${height}, ${gatedPct.toFixed(2)}% differing pixels, and it goes dark again when the gate is removed.`,
  };
}
