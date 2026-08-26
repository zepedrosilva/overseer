// ── Review Feedback Chunker ───────────────────────────────────────────────────
// Splits large, multi-item code reviews into focused, atomic batches (2-3 items)
// to prevent LLM attention degradation and eliminate single-turn timeouts.

export interface FeedbackChunk {
  index: number;
  total: number;
  content: string;
}

export function chunkReviewFeedback(
  rawFeedback: string,
  maxItemsPerChunk: number = 3
): FeedbackChunk[] {
  if (!rawFeedback || rawFeedback.trim().length === 0) {
    return [{ index: 1, total: 1, content: rawFeedback }];
  }

  // 1. Chunk Inline Code Review Threads if present
  if (rawFeedback.includes('--- Thread #')) {
    const threadParts = rawFeedback
      .split(/(?=--- Thread #\d+)/g)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.includes('--- Thread #'));

    if (threadParts.length > maxItemsPerChunk) {
      const chunks: FeedbackChunk[] = [];
      const totalChunks = Math.ceil(threadParts.length / maxItemsPerChunk);

      for (let i = 0; i < threadParts.length; i += maxItemsPerChunk) {
        const slice = threadParts.slice(i, i + maxItemsPerChunk);
        const chunkIndex = Math.floor(i / maxItemsPerChunk) + 1;
        chunks.push({
          index: chunkIndex,
          total: totalChunks,
          content: `### Unresolved Review Threads (Batch ${chunkIndex}/${totalChunks})\n\n${slice.join('\n\n')}`,
        });
      }
      return chunks;
    }
  }

  // 2. Chunk Markdown Bullet / Action Items
  const lines = rawFeedback.split('\n');
  const items: { header?: string; item: string }[] = [];
  let currentHeader = '';
  let currentItemLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('#')) {
      if (currentItemLines.length > 0) {
        items.push({ header: currentHeader, item: currentItemLines.join('\n') });
        currentItemLines = [];
      }
      currentHeader = line;
      continue;
    }

    const isBullet = /^\s*([*-]|\d+\.)\s+/.test(line);
    if (isBullet) {
      if (currentItemLines.length > 0) {
        items.push({ header: currentHeader, item: currentItemLines.join('\n') });
        currentItemLines = [];
      }
      currentItemLines.push(line);
    } else if (currentItemLines.length > 0) {
      currentItemLines.push(line);
    }
  }

  if (currentItemLines.length > 0) {
    items.push({ header: currentHeader, item: currentItemLines.join('\n') });
  }

  if (items.length <= maxItemsPerChunk) {
    return [{ index: 1, total: 1, content: rawFeedback }];
  }

  const chunks: FeedbackChunk[] = [];
  const totalChunks = Math.ceil(items.length / maxItemsPerChunk);

  for (let i = 0; i < items.length; i += maxItemsPerChunk) {
    const slice = items.slice(i, i + maxItemsPerChunk);
    const chunkIndex = Math.floor(i / maxItemsPerChunk) + 1;

    let chunkBody = `### Review Action Items (Batch ${chunkIndex}/${totalChunks})\n\n`;
    let lastHeader = '';
    for (const entry of slice) {
      if (entry.header && entry.header !== lastHeader) {
        chunkBody += `${entry.header}\n`;
        lastHeader = entry.header;
      }
      chunkBody += `${entry.item}\n\n`;
    }

    chunks.push({
      index: chunkIndex,
      total: totalChunks,
      content: chunkBody.trim(),
    });
  }

  return chunks;
}
