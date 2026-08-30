/**
 * Code editor bridge from codeman — file editing and diff patterns.
 */
const fs = require('fs');
const path = require('path');

class CodeEditorBridge {
    constructor(workspace = process.cwd()) {
        this.workspace = workspace;
        this.editHistory = [];
    }

    readFile(relativePath) {
        const fullPath = path.resolve(this.workspace, relativePath);
        if (!fullPath.startsWith(this.workspace)) throw new Error('Path traversal');
        return fs.readFileSync(fullPath, 'utf-8');
    }

    writeFile(relativePath, content) {
        const fullPath = path.resolve(this.workspace, relativePath);
        if (!fullPath.startsWith(this.workspace)) throw new Error('Path traversal');
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const oldContent = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8') : '';
        fs.writeFileSync(fullPath, content, 'utf-8');
        this.editHistory.push({ path: relativePath, timestamp: Date.now(), oldLength: oldContent.length, newLength: content.length });
        return { success: true };
    }

    replaceInFile(relativePath, oldString, newString) {
        const content = this.readFile(relativePath);
        if (!content.includes(oldString)) return { success: false, reason: 'String not found' };
        const updated = content.replace(oldString, newString);
        this.writeFile(relativePath, updated);
        return { success: true, replacements: 1 };
    }

    appendToFile(relativePath, content) {
        const existing = this.readFile(relativePath);
        this.writeFile(relativePath, existing + content);
        return { success: true };
    }

    diff(filePath, oldContent, newContent) {
        const oldLines = oldContent.split('\n');
        const newLines = newContent.split('\n');
        const changes = [];
        const maxLen = Math.max(oldLines.length, newLines.length);
        for (let i = 0; i < maxLen; i++) {
            const oldLine = oldLines[i];
            const newLine = newLines[i];
            if (oldLine !== newLine) {
                changes.push({ line: i + 1, old: oldLine || null, new: newLine || null });
            }
        }
        return { file: filePath, changes, additions: changes.filter(c => !c.old).length, deletions: changes.filter(c => !c.new).length };
    }

    searchFiles(pattern, extensions = ['.ts', '.js', '.py']) {
        const results = [];
        const search = (dir) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    search(fullPath);
                } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
                    const content = fs.readFileSync(fullPath, 'utf-8');
                    const regex = new RegExp(pattern, 'gi');
                    let match;
                    while ((match = regex.exec(content)) !== null) {
                        const lineNum = content.slice(0, match.index).split('\n').length;
                        results.push({ file: path.relative(this.workspace, fullPath), line: lineNum, match: match[0] });
                    }
                }
            }
        };
        search(this.workspace);
        return results;
    }

    getEditHistory() { return this.editHistory; }
}

module.exports = { CodeEditorBridge };
