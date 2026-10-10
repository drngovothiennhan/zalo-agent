// Checks what the downloaded bytes really are before sending them to a vision model. Pure: no imports.
// Vision models reject anything that is not a clean JPEG/PNG/GIF/WebP (error 3030), and a web page or
// error body saved under a picture URL looks exactly like that, so the check is done by file signature.

export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

// Short, safe description of the first bytes, for the event log (no image content)
export function headHex(bytes, n = 8) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  return [...b.slice(0, n)].map((x) => x.toString(16).padStart(2, "0")).join(" ");
}
