// Text helpers shared by the script generators, the renderers and the API layer.
// No dependencies, so every module can import this one without a cycle.

/** Strips control characters, collapses whitespace and caps the length. */
export function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/** Truncates at a word boundary so subtitles never end mid-word. */
export function shorten(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLen * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—-]+$/, '')}…`;
}

/** Splits text into lines that fit maxChars, at most maxLines (the last line is truncated). */
export function wrapLines(text, maxChars, maxLines) {
  const words = String(text || '')
    .split(' ')
    .flatMap((w) => {
      const parts = [];
      for (let i = 0; i < w.length; i += maxChars) parts.push(w.slice(i, i + maxChars));
      return parts;
    });
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current && (current + ' ' + word).length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = shorten(`${kept[maxLines - 1]} ${lines[maxLines]}`, maxChars);
    return kept;
  }
  return lines;
}