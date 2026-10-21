import test from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/vt.js";

const E = "\x1b";

test("plain lines, CR/LF and trailing blanks trimmed", () => {
  assert.equal(render("hello\r\nworld\r\n", 20, 5), "hello\nworld");
});

test("long lines wrap at the column count", () => {
  assert.equal(render("abcdefgh", 5, 3), "abcde\nfgh");
});

test("cursor positioning and erase in line", () => {
  assert.equal(render(`xxxxxxxx${E}[1;3Hab${E}[K`, 10, 2), "xxab");
  assert.equal(render(`${E}[2;4Hz`, 10, 3), "\n   z");
});

test("relative moves, backspace and erase in display", () => {
  assert.equal(render(`abc\b\bX${E}[2C!`, 10, 2), "aXc !");
  assert.equal(render(`one\r\ntwo${E}[2J${E}[Hnew`, 10, 3), "new");
  assert.equal(render(`one\r\ntwo${E}[1;1H${E}[0J`, 10, 3), "");
});

test("output past the last row scrolls up", () => {
  assert.equal(render("1\r\n2\r\n3\r\n4", 5, 3), "2\n3\n4");
});

test("scroll region keeps the lines outside it", () => {
  assert.equal(render(`top\r\n${E}[2;3r${E}[2Ha\r\nb\r\nc${E}[r`, 5, 4), "top\nb\nc");
});

test("alternate screen hides and restores the main screen", () => {
  const out = `shell$ ${E}[?1049h${E}[Hfull screen app`;
  assert.equal(render(out, 20, 3), "full screen app");
  assert.equal(render(`${out}${E}[?1049l`, 20, 3), "shell$");
});

test("colours, titles and charset switches leave no trace", () => {
  assert.equal(render(`${E}]0;title\x07${E}[1;32mok${E}[0m ${E}(Bdone`, 20, 2), "ok done");
});

test("insert and delete characters and lines", () => {
  assert.equal(render(`abcdef${E}[1;2H${E}[2P`, 10, 2), "adef");
  assert.equal(render(`abc${E}[1;2H${E}[2@`, 10, 2), "a  bc");
  assert.equal(render(`1\r\n2\r\n3${E}[2;1H${E}[M`, 5, 3), "1\n3");
  assert.equal(render(`1\r\n2${E}[2;1H${E}[L`, 5, 3), "1\n\n2");
});

test("save and restore the cursor", () => {
  assert.equal(render(`ab${E}7${E}[2;1Hzz${E}8c`, 10, 3), "abc\nzz");
});
