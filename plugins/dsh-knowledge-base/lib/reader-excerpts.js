/** Read-only pages backed by the reading assistant's single Markdown notebook. */
import path from 'node:path';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeMarkdown(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+!|~]/g, '\\$&');
}

/** The code source is fixed; config selects data only, never code from a notebook. */
export function createReaderExcerptProvider({ rootDir } = {}) {
  let store;
  return async function readExcerptPages() {
    if (!store) {
      let reader;
      try { reader = await import('../../dsh-ai-reader/lib/excerpts.js'); }
      catch (error) {
        // An optional companion plugin may not be installed alongside the knowledge base.
        if (error?.code === 'ERR_MODULE_NOT_FOUND') return [];
        throw error;
      }
      store = reader.createExcerptStore({ rootDir: rootDir ? path.resolve(rootDir) : reader.DEFAULT_READER_DATA_DIR });
    }
    const { note } = await store.read();
    const counts = new Map();
    for (const entry of note.entries) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
    return note.entries.filter(entry => UUID.test(entry.id) && counts.get(entry.id) === 1).map(entry => {
      const sourceTitle = entry.article.title || '未命名文章';
      const title = sourceTitle;
      const source = entry.article.url
        ? `[${escapeMarkdown(sourceTitle)}](${entry.article.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : escapeMarkdown(sourceTitle);
      const markdown = `${entry.text.split('\n').map(line => '> ' + escapeMarkdown(line)).join('\n')}\n\n` +
        `标签：${entry.tags.map(escapeMarkdown).join('、')}\n\n` +
        `来源：${source}${entry.article.site ? ` · ${escapeMarkdown(entry.article.site)}` : ''}\n`;
      const pagePath = `reader-excerpts/${entry.id}.md`;
      return {
        path: pagePath, title, type: 'excerpt', readOnly: true, excerptId: entry.id,
        excerptText: entry.text,
        markdown, tags: entry.tags, aliases: [], confidence: '', sources: [],
        article: entry.article, sourceUrl: entry.article.url,
        createdAt: entry.createdAt, updatedAt: entry.createdAt, userEditedAt: null,
        frontmatter: { title, type: 'excerpt', tags: entry.tags, sources: [], readOnly: true },
        topicParent: '', entityCategory: '', entityCategoryAssigned: false, taxonomyEditedAt: '',
        backlinks: [], links: [], sourceRefs: [],
      };
    });
  };
}
