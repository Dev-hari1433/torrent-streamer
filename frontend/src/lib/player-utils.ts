export type BufferedRange = { start: number; end: number };
export function bufferedRanges(ranges: TimeRanges, offset = 0): BufferedRange[] {
  return Array.from({ length: ranges.length }, (_, i) => ({ start: ranges.start(i) + offset, end: ranges.end(i) + offset }));
}
export function containsTime(ranges: BufferedRange[], time: number, margin = 0.15) {
  return ranges.some(range => time >= range.start && time <= range.end - margin);
}
export function bufferAhead(ranges: BufferedRange[], time: number) {
  const range = ranges.find(range => time >= range.start - 0.1 && time <= range.end);
  return range ? Math.max(0, range.end - time) : 0;
}
