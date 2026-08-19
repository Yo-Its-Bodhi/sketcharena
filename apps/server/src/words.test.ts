import { describe, expect, it } from 'vitest';
import { WORDS, randomWord } from './words.js';

const publicDecks = ['chaos', 'classic', 'animals', 'food', 'screen', 'music', 'places', 'crypto', 'legends'];

describe('prompt decks', () => {
  it('ships nine populated decks with enough variety for an eight-round match', () => {
    expect(Object.keys(WORDS).sort()).toEqual([...publicDecks].sort());
    for (const deck of publicDecks) {
      expect(WORDS[deck]?.length).toBeGreaterThanOrEqual(12);
      expect(new Set(WORDS[deck])).toHaveLength(WORDS[deck]!.length);
    }
  });

  it('draws from the selected deck and safely falls back to Arena Chaos', () => {
    expect(randomWord('music', () => 0)).toBe(WORDS.music![0]);
    expect(randomWord('not-a-real-deck', () => 0)).toBe(WORDS.chaos![0]);
  });

  it('skips prompts already used by the room until the deck is exhausted', () => {
    const used = new Set<string>([WORDS.animals![0]!, WORDS.animals![1]!]);
    expect(randomWord('animals', () => 0, used)).toBe(WORDS.animals![2]);
  });
});
