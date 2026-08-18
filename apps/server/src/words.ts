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
  animals: [
    'sleepy sloth', 'disco penguin', 'cat in a spacesuit', 'giraffe on roller skates',
    'detective duck', 'shark with braces', 'llama at a wedding', 'octopus conductor',
    'cowboy hamster', 'frog on a motorcycle', 'bear making pancakes', 'pigeon bodybuilder',
  ],
  food: [
    'pizza', 'birthday cake', 'taco', 'spaghetti', 'ice cream truck', 'sushi chef',
    'angry avocado', 'donut detective', 'hot dog at the beach', 'haunted refrigerator',
    'pancake tower', 'banana on the phone',
  ],
  screen: [
    'Jurassic Park', 'The Matrix', 'Titanic', 'Ghostbusters', 'Finding Nemo', 'Batman',
    'Stranger Things', 'The Lion King', 'Back to the Future', 'Home Alone', 'Shrek', 'Jaws',
  ],
  music: [
    'Taylor Swift', 'The Beatles', 'Beyonce', 'Queen', 'Daft Punk', 'Nirvana',
    'Elvis Presley', 'Lady Gaga', 'Snoop Dogg', 'Spice Girls', 'KISS', 'The Weeknd',
  ],
  places: [
    'Eiffel Tower', 'Grand Canyon', 'Great Wall of China', 'Niagara Falls', 'Mount Everest', 'Stonehenge',
    'Sydney Opera House', 'Las Vegas', 'the Moon', 'Hollywood sign', 'Taj Mahal', 'desert island',
  ],
  legends: [
    'Medusa at the salon', 'dragon with hiccups', 'vampire dentist', 'mermaid in traffic',
    'Bigfoot taking a selfie', 'unicorn mechanic', 'zombie yoga class', 'centaur skateboarder',
    'cyclops optometrist', 'werewolf at the groomer', 'phoenix in a rainstorm', 'Kraken tea party',
  ],
};

export function randomWord(category: string, random = Math.random): string {
  const list = WORDS[category] ?? WORDS.chaos!;
  return list[Math.floor(random() * list.length)]!;
}
