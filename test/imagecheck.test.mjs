// Run with: node --test test/imagecheck.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImage, headHex } from "../src/imagecheck.js";

const pad = (head) => new Uint8Array([...head, ...new Uint8Array(20)]);

test("recognises JPEG, PNG, GIF and WebP by signature", () => {
  assert.equal(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffImage(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "image/gif");
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);
  assert.equal(sniffImage(webp), "image/webp");
});

test("an HTML error page or a truncated body is rejected", () => {
  const html = new TextEncoder().encode("<!DOCTYPE html><html>error page</html>");
  assert.equal(sniffImage(html), null);
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8])), null);
  assert.equal(sniffImage(new Uint8Array(0)), null);
});

test("head bytes are shown in hex for diagnosis", () => {
  assert.equal(headHex(new Uint8Array([0xff, 0xd8, 0x0a])), "ff d8 0a");
});
