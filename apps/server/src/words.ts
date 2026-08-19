export const WORDS: Record<string, string[]> = {
  chaos: [
    'shark doing taxes', 'wizard at the gym', 'haunted toaster', 'penguin wedding',
    'angry spaghetti', 'cow on the moon', 'ninja grandmother', 'dancing volcano',
    'pirate dentist', 'alien first date', 'dramatic potato', 'horse using a laptop',
    'banana police', 'moon on vacation', 'robot birthday', 'ghost at school',
    'dinosaur selfie', 'flying bathtub', 'sad sandwich', 'cat driving a car',
    'dog on a skateboard', 'fish with an umbrella', 'king of pizza', 'monster tea party',
    'chicken superhero', 'sleeping wizard', 'tiny giant', 'dancing skeleton',
  ],
  classic: [
    'lighthouse', 'roller coaster', 'campfire', 'snowman', 'helicopter', 'octopus',
    'treasure map', 'birthday cake', 'traffic jam', 'haunted house', 'waterfall', 'telescope',
    'rainbow', 'volcano', 'pirate ship', 'hot air balloon', 'treehouse', 'fire truck',
    'castle', 'spaceship', 'guitar', 'basketball', 'train station', 'beach',
    'alarm clock', 'sunglasses', 'shopping cart', 'mailbox', 'windmill', 'bridge',
  ],
  crypto: [
    'diamond hands', 'gas fee', 'bear market', 'moon bag', 'rug pull', 'hardware wallet',
    'validator', 'block explorer', 'liquidity pool', 'crypto whale', 'seed phrase', 'airdrop',
    'Bitcoin pizza', 'cold wallet', 'bull market', 'meme coin', 'NFT gallery', 'token swap',
    'crypto miner', 'wallet connect', 'staking rewards', 'smart contract', 'paper hands', 'price chart',
    'green candle', 'red candle', 'secret key', 'digital coin', 'blockchain', 'trading bot',
  ],
  animals: [
    'sleepy sloth', 'disco penguin', 'cat in a hat', 'giraffe',
    'detective duck', 'shark', 'llama', 'octopus',
    'cowboy hamster', 'frog on a bike', 'bear making pancakes', 'strong pigeon',
    'elephant', 'monkey eating a banana', 'dog chasing a ball', 'cat in a box',
    'turtle race', 'rabbit magician', 'lion king', 'penguin on ice',
    'owl reading', 'mouse and cheese', 'crocodile dentist', 'whale fountain',
    'flamingo', 'zebra crossing', 'snail race', 'sheep in boots',
  ],
  food: [
    'pizza', 'birthday cake', 'taco', 'spaghetti', 'ice cream truck', 'sushi chef',
    'angry avocado', 'donut detective', 'hot dog at the beach', 'haunted refrigerator',
    'pancake tower', 'banana on the phone',
    'hamburger', 'popcorn', 'watermelon', 'cupcake', 'french fries', 'fried egg',
    'cookie monster', 'pizza delivery', 'lemonade stand', 'giant sandwich', 'bowl of cereal', 'toast',
    'carrot', 'chocolate bar', 'apple pie', 'noodle bowl', 'coffee cup', 'cheese',
  ],
  screen: [
    'Jurassic Park', 'The Matrix', 'Titanic', 'Ghostbusters', 'Finding Nemo', 'Batman',
    'Stranger Things', 'The Lion King', 'Back to the Future', 'Home Alone', 'Shrek', 'Jaws',
    'Spider-Man', 'Frozen', 'Toy Story', 'Star Wars', 'Harry Potter', 'The Simpsons',
    'Minions', 'Rocky', 'King Kong', 'The Avengers', 'Scooby-Doo', 'SpongeBob',
    'Superman', 'The Wizard of Oz', 'E.T.', 'Barbie', 'Mario', 'Wednesday',
  ],
  music: [
    'Taylor Swift', 'The Beatles', 'Beyonce', 'Queen', 'Daft Punk', 'Nirvana',
    'Elvis Presley', 'Lady Gaga', 'Snoop Dogg', 'Spice Girls', 'KISS', 'The Weeknd',
    'Michael Jackson', 'Madonna', 'Eminem', 'Adele', 'Rihanna', 'Drake',
    'Bruno Mars', 'Dolly Parton', 'Bob Marley', 'AC/DC', 'Gorillaz', 'Coldplay',
    'Ed Sheeran', 'Miley Cyrus', 'Post Malone', 'Elton John', 'Pink Floyd', 'Metallica',
  ],
  places: [
    'Eiffel Tower', 'Grand Canyon', 'Great Wall of China', 'Niagara Falls', 'Mount Everest', 'Stonehenge',
    'Sydney Opera House', 'Las Vegas', 'the Moon', 'Hollywood sign', 'Taj Mahal', 'desert island',
    'Statue of Liberty', 'Big Ben', 'Golden Gate Bridge', 'Egyptian pyramids', 'North Pole', 'volcano island',
    'Times Square', 'Mount Rushmore', 'Colosseum', 'leaning tower', 'ski resort', 'water park',
    'campground', 'haunted castle', 'space station', 'jungle', 'lighthouse island', 'football stadium',
  ],
  legends: [
    'Medusa at the salon', 'dragon with hiccups', 'vampire dentist', 'mermaid in traffic',
    'Bigfoot taking a selfie', 'unicorn mechanic', 'zombie yoga class', 'centaur skateboarder',
    'cyclops optometrist', 'werewolf at the groomer', 'phoenix in a rainstorm', 'Kraken tea party',
    'dragon babysitter', 'vampire at the beach', 'unicorn at school', 'friendly ghost',
    'mermaid rock band', 'zombie birthday', 'Bigfoot camping', 'genie in a bottle',
    'minotaur maze', 'troll under a bridge', 'fairy traffic cop', 'mummy dance party',
    'Loch Ness picnic', 'goblin chef', 'sleeping dragon', 'witch on a scooter',
  ],
};

export function randomWord(category: string, random = Math.random, excluded: ReadonlySet<string> = new Set()): string {
  const list = WORDS[category] ?? WORDS.chaos!;
  const available = list.filter((word) => !excluded.has(word));
  const choices = available.length ? available : list;
  return choices[Math.floor(random() * choices.length)]!;
}
