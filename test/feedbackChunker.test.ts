import { describe, it, expect } from 'vitest';
import { chunkReviewFeedback } from '../src/watcher/feedbackChunker.js';

describe('Review Feedback Chunker', () => {
  it('returns single chunk for small feedback with 3 or fewer items', () => {
    const feedback = `
### Pull Request Reviews
[CHANGES_REQUESTED] @reviewer:
- Fix typo in header
- Add missing null check
`;
    const chunks = chunkReviewFeedback(feedback, 3);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(1);
    expect(chunks[0].total).toBe(1);
    expect(chunks[0].content).toContain('Fix typo in header');
  });

  it('chunks large markdown reviews with many bullets into batches of 3', () => {
    const feedback = `
### Pull Request Reviews
[CHANGES_REQUESTED] @reviewer:
## Major issues (must fix)
- Item 1: Fix memory leak
- Item 2: Add validation
- Item 3: Fix timeout
- Item 4: Fix race condition
- Item 5: Strip credentials
## Smaller notes
- Item 6: Cleanup unused var
- Item 7: Update docs
`;
    const chunks = chunkReviewFeedback(feedback, 3);
    expect(chunks).toHaveLength(3); // 7 items / 3 = 3 batches
    expect(chunks[0].index).toBe(1);
    expect(chunks[0].total).toBe(3);
    expect(chunks[0].content).toContain('Batch 1/3');
    expect(chunks[0].content).toContain('Item 1: Fix memory leak');
    expect(chunks[0].content).toContain('Item 3: Fix timeout');

    expect(chunks[1].index).toBe(2);
    expect(chunks[1].total).toBe(3);
    expect(chunks[1].content).toContain('Batch 2/3');
    expect(chunks[1].content).toContain('Item 4: Fix race condition');

    expect(chunks[2].index).toBe(3);
    expect(chunks[2].total).toBe(3);
    expect(chunks[2].content).toContain('Batch 3/3');
    expect(chunks[2].content).toContain('Item 7: Update docs');
  });

  it('chunks inline review threads by thread boundaries', () => {
    const feedback = `
### Inline Code Review Threads
--- Thread #1 at src/agents/stats.ts:36 ---
@reviewer: Validate record types on parse
--- Thread #2 at src/agents/index.ts:150 ---
@reviewer: Pass explicit allowlist
--- Thread #3 at src/tui/table.ts:196 ---
@reviewer: Remove unused repoName variable
--- Thread #4 at src/watcher/autonomous.ts:50 ---
@reviewer: Cap prReviewedKeys size
--- Thread #5 at src/tui/agentModal.ts:80 ---
@reviewer: Load custom playbooks dynamically
`;
    const chunks = chunkReviewFeedback(feedback, 2);
    expect(chunks).toHaveLength(3); // 5 threads / 2 = 3 batches
    expect(chunks[0].index).toBe(1);
    expect(chunks[0].total).toBe(3);
    expect(chunks[0].content).toContain('Batch 1/3');
    expect(chunks[0].content).toContain('Thread #1');
    expect(chunks[0].content).toContain('Thread #2');

    expect(chunks[1].index).toBe(2);
    expect(chunks[1].total).toBe(3);
    expect(chunks[1].content).toContain('Batch 2/3');
    expect(chunks[1].content).toContain('Thread #3');
    expect(chunks[1].content).toContain('Thread #4');

    expect(chunks[2].index).toBe(3);
    expect(chunks[2].total).toBe(3);
    expect(chunks[2].content).toContain('Batch 3/3');
    expect(chunks[2].content).toContain('Thread #5');
  });

  it('handles empty or blank feedback gracefully', () => {
    const chunks = chunkReviewFeedback('', 3);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(1);
    expect(chunks[0].total).toBe(1);
  });
});
