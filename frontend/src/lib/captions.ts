export interface Caption { start: number; end: number; text: string }
const timestamp = (value: string) => value.trim().replace(',', '.').split(':').reduce((total, part) => total * 60 + Number(part), 0);
export function parseCaptions(input: string): Caption[] {
  return input.replace(/^\uFEFF/, '').split(/\r?\n\s*\r?\n/).flatMap(block => {
    const lines = block.split(/\r?\n/); const index = lines.findIndex(line => line.includes('-->'));
    if (index < 0) return [];
    const match = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[index]); if (!match) return [];
    const start = timestamp(match[1]); const end = timestamp(match[2]); const text = lines.slice(index + 1).join('\n').trim();
    return Number.isFinite(start) && end > start && text ? [{ start, end, text }] : [];
  }).slice(0, 10000);
}
