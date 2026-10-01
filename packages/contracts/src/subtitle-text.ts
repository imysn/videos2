// WebVTT entities decoded into plain text. Never interpret cues as HTML.
export function decodeCueText(text: string) {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    nbsp: "\u00a0",
    lrm: "\u200e",
    rlm: "\u200f",
    quot: '"',
    apos: "'",
  };
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|nbsp|lrm|rlm|quot|apos);/gi,
    (whole, entity: string) => {
      if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
      const code =
        entity.startsWith("#x") || entity.startsWith("#X")
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return Number.isInteger(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "\ufffd";
    },
  );
}
export function encodeCueText(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
