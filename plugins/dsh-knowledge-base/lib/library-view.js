/** Identity and presentation rules for the main library. Stored records keep their own paths. */
import path from 'node:path';

const compact = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function documentMatchesSource(title, source, alternateTitle = '') {
  const name = compact(title);
  if (name.length < 4 || !source) return false;
  const names = [source.title, alternateTitle];
  if (source.kind === 'file' && source.name) {
    const stem = path.parse(source.name).name;
    names.push(stem, stem.replace(/^\d+[_ -]+/, ''));
  }
  return names.some(value => name === compact(value));
}

export function sourceForWikiPage(page, sources) {
  if (page?.sources?.length !== 1 || !Object.hasOwn(sources, page.sources[0])) return null;
  const source = sources[page.sources[0]];
  if (!source) return null;
  if (page.type === 'source') return source;
  if (page.type === 'entity' && page.entityCategory === 'document' && documentMatchesSource(page.title, source)) return source;
  return null;
}

function shingles(text) {
  const items = new Set();
  for (let start = 0; start <= text.length - 12; start++) items.add(text.slice(start, start + 12));
  return items;
}

function almostSameArticle(a, b) {
  if (a.text === b.text) return true;
  const short = Math.min(a.text.length, b.text.length);
  const long = Math.max(a.text.length, b.text.length);
  if (short / long < 0.98) return false;
  // Require matching content across the body before doing the full comparison.
  for (const fraction of [0.25, 0.5, 0.75]) {
    const start = Math.floor(a.text.length * fraction);
    if (!b.text.includes(a.text.slice(start, start + 48))) return false;
  }
  a.shingles ??= shingles(a.text);
  b.shingles ??= shingles(b.text);
  let shared = 0;
  for (const item of a.shingles) if (b.shingles.has(item)) shared++;
  return shared / (a.shingles.size + b.shingles.size - shared) >= 0.98;
}

/** Conservative grouping for text editions with provenance URLs, never an ingest or deletion rule. */
export function sourceVersionGroups(rows) {
  const groups = [];
  for (const { source, text } of rows) {
    if (text.length > 40000) continue;
    const normalized = compact(text);
    if (normalized.length < 700 || normalized.length > 20000) continue;
    const item = { source, text: normalized, shingles: null };
    const group = groups.find(group => group.every(other => almostSameArticle(item, other)));
    if (group) group.push(item);
    else groups.push([item]);
  }
  const editions = new Map();
  for (const group of groups) {
    if (group.length < 2) continue;
    const versions = group.map(item => item.source);
    for (const source of versions) editions.set(source.id, versions);
  }
  return editions;
}
