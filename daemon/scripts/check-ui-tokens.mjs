// One token source for the hub: spacing, type, colour, radius and motion are written in the :root
// block of public/ui/app.css, and this refuses a raw value anywhere else. It runs from `npm run
// check`, the same step CI calls, so a raw #hex or 12px cannot land without a token behind it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const ui = path.join(root, "public", "ui");
const rel = (file) => path.relative(root, file).replace(/\\/g, "/");

const SPACING = new Set([
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "row-gap",
  "column-gap",
  "inset",
  "top",
  "right",
  "bottom",
  "left",
]);
const MOTION = new Set(["transition", "animation", "transition-duration", "animation-duration"]);
const PX = /\d+(?:\.\d+)?px\b/;
const HEX = /#[0-9a-fA-F]{3,8}\b/;

const problems = [];
const at = (file, line, message) => problems.push(`${rel(file)}:${line}: ${message}`);

/** Comments blanked, newlines kept, so a report still points at the real line. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function checkDecl(file, line, prop, value) {
  if (SPACING.has(prop) && PX.test(value)) at(file, line, `${prop} carries a raw pixel value; use --space-*`);
  else if (prop === "border-radius" && PX.test(value))
    at(file, line, `border-radius carries a raw pixel value; use --radius-*`);
  else if (prop === "font-size" && PX.test(value))
    at(file, line, `font-size carries a raw pixel value; use --text-*`);
  else if (prop === "font" && /^\s*\d+(?:\.\d+)?px/.test(value))
    at(file, line, `font carries a raw pixel size; use --text-*`);
  else if (MOTION.has(prop) && /(^|[\s,])\d*\.?\d+m?s\b/.test(value))
    at(file, line, `${prop} carries a literal duration; use --motion-*`);
}

const tokens = new Set();
const cssFiles = fs
  .readdirSync(ui)
  .filter((f) => f.endsWith(".css"))
  .map((f) => path.join(ui, f));

for (const file of cssFiles) {
  const lines = stripComments(fs.readFileSync(file, "utf8")).split(/\r?\n/);
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = line.indexOf("{");
    const selector = open >= 0 ? line.slice(0, open).trim() : "";
    const inRoot = Boolean(selector.startsWith(":root")) || stack.some((s) => s.startsWith(":root"));
    if (inRoot) for (const m of line.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) tokens.add(m[1]);
    if (open >= 0) {
      for (const decl of line.slice(open + 1).split(";")) {
        const colon = decl.indexOf(":");
        if (colon < 0) continue;
        const prop = decl.slice(0, colon).trim();
        const value = decl.slice(colon + 1);
        if (inRoot) continue;
        if (HEX.test(value) || /\b(?:rgba?|hsla?)\(/.test(value))
          at(file, i + 1, `raw colour ${value.trim().slice(0, 40)}; use a colour token`);
        checkDecl(file, i + 1, prop, value);
      }
      stack.push(selector);
    }
    const closes = (line.match(/\}/g) || []).length;
    for (let k = 0; k < closes; k++) stack.pop();
  }
}

// Every token has to be spent somewhere, or the block grows dead settings.
const allText = [
  ...cssFiles,
  ...fs
    .readdirSync(ui)
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(ui, f)),
].map((f) => fs.readFileSync(f, "utf8"));
for (const token of tokens)
  if (!allText.some((t) => t.includes(`var(${token})`))) at(ui, 0, `${token} is defined and never used`);

// Inline style strings are for runtime geometry; a static one has to be a class.
for (const name of fs.readdirSync(ui).filter((f) => f.endsWith(".js"))) {
  const file = path.join(ui, name);
  fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const m of line.matchAll(/\bstyle\s*[:=]\s*"([^"]*)"/g))
        if (HEX.test(m[1]) || PX.test(m[1])) at(file, i + 1, `inline style carries a raw value (${m[1]})`);
    });
}

if (problems.length) {
  console.error(`ui tokens: ${problems.length} raw value(s)\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `ui tokens: ${tokens.size} definitions, all referenced; no raw colour, spacing, radius, type or duration outside the token block`,
);
