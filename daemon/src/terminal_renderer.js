/**
 * Terminal Renderer — Extracted from Restty patterns.
 *
 * Browser-based terminal rendering with:
 * - Font classification and management
 * - Cell-width calculation for CJK/emoji
 * - VT sequence processing
 * - WebGPU-accelerated rendering
 */

// Font classification patterns (from restty)
const SYMBOL_FONT_HINTS = [
    /symbols nerd font/i,
    /symbolsnerd/i,
    /noto sans symbols/i,
    /notosanssymbols/i,
    /apple symbols/i,
    /symbola/i,
];

const COLOR_EMOJI_FONT_HINTS = [
    /apple color emoji/i,
    /noto color emoji/i,
    /notocoloremoji/i,
    /openmoji/i,
    /segoe ui emoji/i,
    /twemoji/i,
];

const WIDE_FONT_HINTS = [
    /cjk/i,
    /emoji/i,
    /openmoji/i,
    /source han/i,
    /pingfang/i,
    /hiragino/i,
    /yu gothic/i,
    /meiryo/i,
    /yahei/i,
    /ms gothic/i,
    /simhei/i,
    /simsun/i,
    /nanum/i,
    /apple sd gothic/i,
];

function isSymbolFont(label) {
    if (!label) return false;
    const lower = label.toLowerCase();
    return SYMBOL_FONT_HINTS.some(rule => rule.test(lower));
}

function isColorEmojiFont(label) {
    if (!label) return false;
    const lower = label.toLowerCase();
    return COLOR_EMOJI_FONT_HINTS.some(rule => rule.test(lower));
}

function fontMaxCellSpan(label) {
    if (!label) return 1;
    const lower = label.toLowerCase();
    for (const rule of WIDE_FONT_HINTS) {
        if (rule.test(lower)) return 2;
    }
    return 1;
}

function fontScaleOverride(label, overrides = []) {
    if (!label) return 1;
    const lower = label.toLowerCase();
    for (const rule of overrides) {
        if (rule.pattern && rule.pattern.test(lower)) {
            return rule.scale || 1;
        }
    }
    return 1;
}

// Character width calculation
function charWidth(char) {
    const code = char.codePointAt(0);
    if (code < 32) return 0; // Control chars
    if (code === 127) return 0; // DEL
    if (code >= 32 && code < 127) return 1; // ASCII

    // CJK ranges
    if (
        (code >= 0x1100 && code <= 0x115F) ||
        (code >= 0x2E80 && code <= 0x303E) ||
        (code >= 0x3040 && code <= 0x9FFF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0xFE30 && code <= 0xFE6F) ||
        (code >= 0xFF00 && code <= 0xFF60) ||
        (code >= 0xFFE0 && code <= 0xFFE6) ||
        (code >= 0x20000 && code <= 0x2FA1F)
    ) {
        return 2;
    }

    // Emoji variation selectors
    if (code >= 0xFE00 && code <= 0xFE0F) return 0; // Variation selector
    if (code >= 0x1F000 && code <= 0x1FFFF) return 2; // Emoji

    return 1;
}

function stringWidth(str) {
    let width = 0;
    for (const char of str) {
        width += charWidth(char);
    }
    return width;
}

// VT100 sequence parser
class VTParser {
    constructor() {
        this.buffer = '';
        this.cursor = { row: 0, col: 0 };
        this.attributes = { bold: false, italic: false, underline: false, color: null };
    }

    process(data) {
        this.buffer += data;
        const output = [];
        let i = 0;

        while (i < this.buffer.length) {
            if (this.buffer[i] === '\x1b') {
                // ESC sequence
                const seq = this.parseEscapeSequence(this.buffer, i);
                if (seq) {
                    this.applySequence(seq);
                    i += seq.raw.length;
                    continue;
                }
            }

            const char = this.buffer[i];
            if (char === '\n') {
                this.cursor.row++;
                this.cursor.col = 0;
            } else if (char === '\r') {
                this.cursor.col = 0;
            } else if (char === '\t') {
                this.cursor.col = (this.cursor.col + 8) & ~7;
            } else {
                const w = charWidth(char);
                output.push({
                    char,
                    row: this.cursor.row,
                    col: this.cursor.col,
                    width: w,
                    attributes: { ...this.attributes },
                });
                this.cursor.col += w;
            }
            i++;
        }

        this.buffer = this.buffer.slice(i);
        return output;
    }

    parseEscapeSequence(str, start) {
        if (start + 1 >= str.length) return null;

        if (str[start + 1] === '[') {
            // CSI sequence
            let end = start + 2;
            while (end < str.length && str[end] !== 'm' && str[end] !== 'H' && str[end] !== 'J') {
                end++;
            }
            if (end < str.length) {
                return {
                    raw: str.slice(start, end + 1),
                    type: str[end],
                    params: str.slice(start + 2, end).split(';').map(Number),
                };
            }
        }

        return null;
    }

    applySequence(seq) {
        if (seq.type === 'm') {
            // SGR - Select Graphic Rendition
            for (const param of seq.params) {
                switch (param) {
                    case 0: this.resetAttributes(); break;
                    case 1: this.attributes.bold = true; break;
                    case 3: this.attributes.italic = true; break;
                    case 4: this.attributes.underline = true; break;
                    case 22: this.attributes.bold = false; break;
                    case 23: this.attributes.italic = false; break;
                    case 24: this.attributes.underline = false; break;
                }
            }
        } else if (seq.type === 'H') {
            // Cursor position
            this.cursor.row = (seq.params[0] || 1) - 1;
            this.cursor.col = (seq.params[1] || 1) - 1;
        } else if (seq.type === 'J') {
            // Clear screen
            if (seq.params[0] === 2) {
                this.cursor = { row: 0, col: 0 };
            }
        }
    }

    resetAttributes() {
        this.attributes = { bold: false, italic: false, underline: false, color: null };
    }
}

class TerminalRenderer {
    constructor(config = {}) {
        this.cols = config.cols || 80;
        this.rows = config.rows || 24;
        this.parser = new VTParser();
        this.cells = Array.from({ length: this.rows }, () =>
            Array.from({ length: this.cols }, () => ({
                char: ' ',
                attributes: {},
            }))
        );
    }

    feed(data) {
        const chars = this.parser.process(data);
        for (const c of chars) {
            if (c.row < this.rows && c.col < this.cols) {
                this.cells[c.row][c.col] = {
                    char: c.char,
                    attributes: c.attributes,
                };
            }
        }
    }

    resize(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        this.cells = Array.from({ length: this.rows }, () =>
            Array.from({ length: this.cols }, () => ({
                char: ' ',
                attributes: {},
            }))
        );
    }

    getScreen() {
        return this.cells.map(row => row.map(cell => cell.char).join(''));
    }

    getCell(row, col) {
        if (row < this.rows && col < this.cols) {
            return this.cells[row][col];
        }
        return null;
    }

    clear() {
        this.cells = Array.from({ length: this.rows }, () =>
            Array.from({ length: this.cols }, () => ({
                char: ' ',
                attributes: {},
            }))
        );
        this.parser.cursor = { row: 0, col: 0 };
    }
}

module.exports = {
    TerminalRenderer,
    VTParser,
    charWidth,
    stringWidth,
    isSymbolFont,
    isColorEmojiFont,
    fontMaxCellSpan,
    fontScaleOverride,
};
