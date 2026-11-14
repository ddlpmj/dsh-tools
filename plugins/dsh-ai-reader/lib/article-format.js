// Portable, bounded article formatting. Text remains the canonical content.
export function safeArticleColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '';
}

export function safeArticleHref(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value) || /[\s\x00-\x1f\x7f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

export function normalizeTableAlignment(value) {
  return value === 'left' || value === 'center' || value === 'right' ? value : '';
}

export function normalizeTextRuns(raw, text) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 2048 || typeof text !== 'string') return undefined;
  const runs = [];
  let length = 0;
  let formatted = false;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.text !== 'string') return undefined;
    length += item.text.length;
    if (length > text.length) return undefined;
    if (!item.text) continue;
    const run = { text: item.text };
    for (const key of ['bold', 'italic', 'underline', 'strike', 'code']) {
      if (item[key] === true) { run[key] = true; formatted = true; }
    }
    for (const key of ['color', 'backgroundColor']) {
      const value = safeArticleColor(item[key]);
      if (value) { run[key] = value; formatted = true; }
    }
    const href = safeArticleHref(item.href);
    if (href) { run.href = href; formatted = true; }
    const last = runs[runs.length - 1];
    if (last && ['bold', 'italic', 'underline', 'strike', 'code', 'color', 'backgroundColor', 'href'].every(key => last[key] === run[key])) {
      last.text += run.text;
    } else runs.push(run);
  }
  if (!formatted || length !== text.length || runs.map(run => run.text).join('') !== text) return undefined;
  return runs;
}

function luminance(color) {
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

export function articleColorContrast(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Explicit background/foreground pairs work in either appearance. Isolated
// source text colors blend with the reader foreground to keep its theme.
export function articleRunColors(run, foregroundVariable = '--fg') {
  const backgroundColor = safeArticleColor(run?.backgroundColor);
  const sourceColor = safeArticleColor(run?.color);
  if (backgroundColor) {
    const color = sourceColor && articleColorContrast(sourceColor, backgroundColor) >= 4.5
      ? sourceColor
      : articleColorContrast('#000000', backgroundColor) >= articleColorContrast('#ffffff', backgroundColor) ? '#000000' : '#ffffff';
    return { color, backgroundColor };
  }
  if (!sourceColor) return {};
  const rgb = [1, 3, 5].map(offset => parseInt(sourceColor.slice(offset, offset + 2), 16));
  if (Math.max(...rgb) - Math.min(...rgb) <= 12) return {};
  return { color: `color-mix(in srgb,${sourceColor} 35%,var(${foregroundVariable},currentColor) 65%)` };
}
