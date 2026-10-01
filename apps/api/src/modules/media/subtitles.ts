import { assert } from "../../infrastructure/errors.js";
import {
  decodeCueText,
  encodeCueText,
} from "../../../../../packages/contracts/src/subtitle-text.js";
export interface Cue {
  start: number;
  end: number;
  text: string;
}
function time(value: string) {
  const m = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value.trim());
  assert(m, "INVALID_SUBTITLE");
  const t =
    Number(m[1] ?? 0) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number(m[4]) / 1000;
  assert(Number(m[2]) < 60 && Number(m[3]) < 60, "INVALID_SUBTITLE");
  return t;
}
export function parseSubtitles(raw: string): Cue[] {
  assert(
    Buffer.byteLength(raw, "utf8") <= 5242880 && !raw.includes("\0"),
    "INVALID_SUBTITLE",
  );
  let content = raw.replace(/^\uFEFF/, "").replace(/\r/g, "");
  content = content.replace(/^WEBVTT[^\n]*\n/, "");
  const cues: Cue[] = [];
  for (const block of content.split(/\n\s*\n/)) {
    const lines = block.trim().split("\n");
    if (!lines[0] || lines[0].startsWith("NOTE")) continue;
    const index = lines.findIndex((l) => l.includes("-->"));
    assert(index >= 0 && index <= 1, "INVALID_SUBTITLE");
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index]);
    assert(match, "INVALID_SUBTITLE");
    const start = time(match[1]),
      end = time(match[2]);
    assert(
      end > start &&
        (cues.length === 0 || start >= cues[cues.length - 1].start),
      "INVALID_SUBTITLE",
    );
    const text = decodeCueText(
      lines
        .slice(index + 1)
        .join("\n")
        .replace(/<[^>]*>/g, "")
        .replace(/-->/g, "→"),
    );
    assert(text.length <= 10000 && cues.length < 100000, "INVALID_SUBTITLE");
    cues.push({ start, end, text });
  }
  assert(cues.length, "INVALID_SUBTITLE");
  return cues;
}
export function vttTime(t: number) {
  const ms = Math.round(t * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
export function toVtt(cues: Cue[]) {
  return (
    "WEBVTT\n\n" +
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${encodeCueText(c.text)}\n`,
      )
      .join("\n")
  );
}
