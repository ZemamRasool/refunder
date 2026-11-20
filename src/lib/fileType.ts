// Checks what a file really is by looking at its first bytes, instead of trusting
// the name or the type the browser claims. A renamed .exe will not pass as a .pdf.

export type AllowedType = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "application/pdf" | "text/plain";

export function sniffType(data: Buffer): AllowedType | null {
  if (data.length < 4) return looksLikeText(data) ? "text/plain" : null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return looksLikeText(data) ? "text/plain" : null;
}

function looksLikeText(data: Buffer): boolean {
  const sample = data.subarray(0, 4096);
  if (sample.includes(0)) return false;
  try {
    // stream:true so a multi-byte letter cut off at the end of the sample is not an error
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}
