/** Take a prefix of `text` whose JSON-serialized form (without the quotes)
 * is at most `maxBytes` of UTF-8.  Counting UTF-16 units under-counts CJK
 * (3 bytes each) and control characters (a NUL serializes as the 6-byte
 * "\u0000"), so a unit-count slice can blow a response budget; walking code
 * points also never splits an emoji's surrogate pair. */
export function serializedPreview(text: string, maxBytes: number): { preview: string; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(JSON.stringify(codePoint), "utf8") - 2;
    if (bytes + size > maxBytes) return { preview: text.slice(0, end), truncated: true };
    bytes += size;
    end += codePoint.length;
  }
  return { preview: text, truncated: false };
}
