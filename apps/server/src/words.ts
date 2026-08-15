export const WORDS: Record<string, string[]> = {
  chaos: [
    'shark doing taxes', 'wizard at the gym', 'haunted toaster', 'penguin wedding',
    'angry spaghetti', 'cow on the moon', 'ninja grandmother', 'dancing volcano',
    'pirate dentist', 'alien first date', 'dramatic potato', 'horse using a laptop',
  ],
  classic: [
    'lighthouse', 'roller coaster', 'campfire', 'snowman', 'helicopter', 'octopus',
    'treasure map', 'birthday cake', 'traffic jam', 'haunted house', 'waterfall', 'telescope',
  ],
  crypto: [
    'diamond hands', 'gas fee', 'bear market', 'moon bag', 'rug pull', 'hardware wallet',
    'validator', 'block explorer', 'liquidity pool', 'crypto whale', 'seed phrase', 'airdrop',
  ],
};

export function randomWord(category: string, random = Math.random): string {
  const list = WORDS[category] ?? WORDS.chaos!;
  return list[Math.floor(random() * list.length)]!;
}
