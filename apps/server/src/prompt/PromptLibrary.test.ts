import { describe, expect, it } from 'vitest';
import { MemoryPromptRepository, PromptLibrary, PROMPT_CATEGORIES } from './PromptLibrary.js';

describe('PromptLibrary', () => {
  it('seeds every category with all three honest difficulty tiers', async () => {
    const library = new PromptLibrary(new MemoryPromptRepository(), () => Date.UTC(2026, 7, 18)); await library.load();
    for (const category of PROMPT_CATEGORIES) for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const picked = library.choose('category', category, difficulty, new Set(), () => 0);
      expect(library.list().find((card) => card.text === picked && card.category === category)).toMatchObject({ category, difficulty, active: true });
    }
  });

  it('uses a stable daily rotation and avoids every fresh card before recycling', async () => {
    const library = new PromptLibrary(new MemoryPromptRepository(), () => Date.UTC(2026, 7, 18)); await library.load();
    expect(library.summary()).toMatchObject({ dailySize: 60, rotationKey: '2026-08-18' });
    const excluded = new Set<string>();
    for (let index = 0; index < 12; index += 1) excluded.add(library.choose('daily', 'chaos', 'mixed', excluded, () => 0));
    expect(excluded.size).toBe(12);
  });

  it('rejects normalized duplicates and lets admins pause cards without deleting history', async () => {
    const library = new PromptLibrary(new MemoryPromptRepository()); await library.load();
    await expect(library.create({ text: '  LIGHTHOUSE ', category: 'classic', difficulty: 'easy', active: true })).rejects.toThrow('already exists');
    const card = library.list()[0]!; await library.update(card.id, { active: false });
    expect(library.list().find((value) => value.id === card.id)?.active).toBe(false);
  });
});
