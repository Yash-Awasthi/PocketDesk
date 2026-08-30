"""
QR code generator from qrcode-generator patterns.
"""
class QRGenerator {
    static generate(text, size = 256) {
        const modules = QRGenerator.encode(text);
        const moduleSize = Math.floor(size / modules.length);
        return { modules, moduleSize, size: modules.length * moduleSize };
    }

    static encode(text) {
        const size = Math.max(21, Math.ceil(Math.sqrt(text.length * 8)) + 21);
        const modules = Array.from({ length: size }, () => Array(size).fill(0));
        QRGenerator.addFinderPatterns(modules);
        QRGenerator.addData(modules, text);
        return modules;
    }

    static addFinderPatterns(modules) {
        const size = modules.length;
        const pattern = (r, c) => {
            for (let dr = -1; dr <= 7; dr++) {
                for (let dc = -1; dc <= 7; dc++) {
                    const rr = r + dr, cc = c + dc;
                    if (rr >= 0 && rr < size && cc >= 0 && cc < size) {
                        const inBorder = dr === -1 || dr === 7 || dc === -1 || dc === 7;
                        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
                        modules[rr][cc] = inBorder ? 0 : inInner ? 1 : (dr === 0 || dr === 6 || dc === 0 || dc === 6) ? 1 : 0;
                    }
                }
            }
        };
        pattern(0, 0);
        pattern(0, size - 7);
        pattern(size - 7, 0);
    }

    static addData(modules, text) {
        const size = modules.length;
        let row = size - 1, col = size - 1, dir = -1;
        for (const char of text) {
            const bits = char.charCodeAt(0).toString(2).padStart(8, '0');
            for (const bit of bits) {
                if (row >= 0 && row < size && col >= 0 && col < size && !modules[row][col]) {
                    modules[row][col] = parseInt(bit);
                }
                row += dir;
                if (row < 0 || row >= size) { col -= 2; dir = -dir; row += dir; }
            }
        }
    }

    static toSVG(modules, moduleSize = 10) {
        const size = modules.length * moduleSize;
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;
        svg += `<rect width="${size}" height="${size}" fill="white"/>`;
        for (let r = 0; r < modules.length; r++) {
            for (let c = 0; c < modules[r].length; c++) {
                if (modules[r][c]) svg += `<rect x="${c * moduleSize}" y="${r * moduleSize}" width="${moduleSize}" height="${moduleSize}" fill="black"/>`;
            }
        }
        return svg + '</svg>';
    }
}

module.exports = { QRGenerator };
