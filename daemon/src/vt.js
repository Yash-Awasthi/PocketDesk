// The screen a terminal would show for a stream of output: enough VT100/xterm for shells and
// full-screen agents to read back as text. Colours and other attributes are dropped.
// ponytail: one cell per code point; wide CJK/emoji cells and combining marks shift the line.

export class VT {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.main = this.blank();
    this.alt = null;
    this.lines = this.main;
    this.x = 0;
    this.y = 0;
    this.wrap = false; // the last column was just written; the next character goes to a new line
    this.top = 0;
    this.bottom = rows - 1;
    this.saved = { x: 0, y: 0 };
    this.state = "text";
    this.seq = "";
  }

  blank() { return Array.from({ length: this.rows }, () => this.row()); }
  row() { return new Array(this.cols).fill(" "); }

  write(s) {
    for (const ch of s) {
      switch (this.state) {
        case "text": this.text(ch); break;
        case "esc": this.escape(ch); break;
        case "csi":
          if (ch >= "@" && ch <= "~") { this.state = "text"; this.csi(this.seq, ch); }
          else this.seq += ch;
          break;
        case "osc": // ends at BEL or ESC \
          if (ch === "\x07") this.state = "text";
          else if (ch === "\x1b") this.state = "oscEsc";
          break;
        case "oscEsc": this.state = ch === "\\" ? "text" : "osc"; break;
        case "charset": this.state = "text"; break;
      }
    }
  }

  text(ch) {
    if (ch === "\x1b") { this.state = "esc"; return; }
    if (ch === "\r") { this.x = 0; this.wrap = false; return; }
    if (ch === "\n" || ch === "\v" || ch === "\f") { this.lineFeed(); return; }
    if (ch === "\b") { this.x = Math.max(0, this.x - 1); this.wrap = false; return; }
    if (ch === "\t") { this.x = Math.min(this.cols - 1, (this.x >> 3) * 8 + 8); return; }
    if (ch < " " || ch === "\x7f") return;
    if (this.wrap) { this.x = 0; this.lineFeed(); }
    this.lines[this.y][this.x] = ch;
    if (this.x === this.cols - 1) this.wrap = true;
    else this.x++;
  }

  escape(ch) {
    this.state = "text";
    if (ch === "[") { this.state = "csi"; this.seq = ""; }
    else if (ch === "]") this.state = "osc";
    else if ("()*+".includes(ch)) this.state = "charset";
    else if (ch === "7") this.saved = { x: this.x, y: this.y };
    else if (ch === "8") { this.x = this.saved.x; this.y = this.saved.y; this.wrap = false; }
    else if (ch === "D") this.lineFeed();
    else if (ch === "E") { this.x = 0; this.lineFeed(); }
    else if (ch === "M") { if (this.y === this.top) this.scrollDown(1); else this.y = Math.max(0, this.y - 1); }
    else if (ch === "c") Object.assign(this, new VT(this.cols, this.rows));
  }

  lineFeed() {
    this.wrap = false;
    if (this.y === this.bottom) this.scrollUp(1);
    else if (this.y < this.rows - 1) this.y++;
  }

  scrollUp(n) {
    for (let i = 0; i < n; i++) { this.lines.splice(this.top, 1); this.lines.splice(this.bottom, 0, this.row()); }
  }

  scrollDown(n) {
    for (let i = 0; i < n; i++) { this.lines.splice(this.bottom, 1); this.lines.splice(this.top, 0, this.row()); }
  }

  csi(seq, final) {
    const priv = seq.startsWith("?");
    const args = seq.replace(/^[?>=<]/, "").split(";").map((v) => parseInt(v, 10));
    const n = (i = 0, def = 1) => (Number.isFinite(args[i]) && args[i] > 0 ? args[i] : def);
    const clampY = (y) => Math.max(0, Math.min(this.rows - 1, y));
    const clampX = (x) => Math.max(0, Math.min(this.cols - 1, x));
    const line = this.lines[this.y];
    this.wrap = false;
    if (priv) {
      // 1049/1047/47: the alternate screen full-screen apps draw on.
      if ((final === "h" || final === "l") && args.some((a) => a === 1049 || a === 1047 || a === 47)) {
        if (final === "h" && !this.alt) {
          if (args.includes(1049)) this.saved = { x: this.x, y: this.y };
          this.alt = this.blank();
          this.lines = this.alt;
        } else if (final === "l" && this.alt) {
          this.alt = null;
          this.lines = this.main;
          if (args.includes(1049)) { this.x = this.saved.x; this.y = this.saved.y; }
        }
      }
      return;
    }
    switch (final) {
      case "A": this.y = Math.max(this.y >= this.top ? this.top : 0, this.y - n()); break;
      case "B": this.y = Math.min(this.y <= this.bottom ? this.bottom : this.rows - 1, this.y + n()); break;
      case "C": this.x = clampX(this.x + n()); break;
      case "D": this.x = clampX(this.x - n()); break;
      case "E": this.x = 0; this.y = clampY(this.y + n()); break;
      case "F": this.x = 0; this.y = clampY(this.y - n()); break;
      case "G": case "`": this.x = clampX(n() - 1); break;
      case "d": this.y = clampY(n() - 1); break;
      case "H": case "f": this.y = clampY(n(0) - 1); this.x = clampX(n(1) - 1); break;
      case "J": {
        const mode = args[0] || 0;
        if (mode === 0) { line.fill(" ", this.x); for (let y = this.y + 1; y < this.rows; y++) this.lines[y].fill(" "); }
        else if (mode === 1) { line.fill(" ", 0, this.x + 1); for (let y = 0; y < this.y; y++) this.lines[y].fill(" "); }
        else for (const l of this.lines) l.fill(" ");
        break;
      }
      case "K": {
        const mode = args[0] || 0;
        if (mode === 0) line.fill(" ", this.x);
        else if (mode === 1) line.fill(" ", 0, this.x + 1);
        else line.fill(" ");
        break;
      }
      case "X": line.fill(" ", this.x, Math.min(this.cols, this.x + n())); break;
      case "P": line.splice(this.x, Math.min(n(), this.cols - this.x)); while (line.length < this.cols) line.push(" "); break;
      case "@": line.splice(this.x, 0, ...new Array(Math.min(n(), this.cols - this.x)).fill(" ")); line.length = this.cols; break;
      case "L": case "M": {
        if (this.y < this.top || this.y > this.bottom) break;
        const top = this.top;
        this.top = this.y;
        if (final === "L") this.scrollDown(Math.min(n(), this.bottom - this.y + 1));
        else this.scrollUp(Math.min(n(), this.bottom - this.y + 1));
        this.top = top;
        this.x = 0;
        break;
      }
      case "S": this.scrollUp(n()); break;
      case "T": this.scrollDown(n()); break;
      case "r": {
        const t = n(0) - 1, b = n(1, this.rows) - 1;
        if (t < b && b < this.rows) { this.top = t; this.bottom = b; }
        else { this.top = 0; this.bottom = this.rows - 1; }
        this.x = 0;
        this.y = 0;
        break;
      }
      case "s": this.saved = { x: this.x, y: this.y }; break;
      case "u": this.x = this.saved.x; this.y = this.saved.y; break;
    }
  }

  /** Screen text: trailing spaces and empty bottom lines dropped. */
  screen() {
    return this.lines.map((l) => l.join("").trimEnd()).join("\n").replace(/\n+$/, "");
  }
}

export function render(text, cols, rows) {
  const vt = new VT(cols, rows);
  vt.write(text);
  return vt.screen();
}
