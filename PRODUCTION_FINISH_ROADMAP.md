# Sketch Arena production-finish roadmap

Updated: 2026-08-17

## Milestone 1 — Core game and creative loop

- [x] Eight drawings in every match at every supported room size.
- [x] Fair rotating drawer schedule for 2–8 connected players.
- [x] Explicit tiebreak chain: points, correct guesses, combined solve time, shared crown.
- [x] Acknowledged, segmented long-stroke transport and bounded server storage.
- [x] Idempotent “Keep this disaster” Vault saves.
- [x] Nine real prompt decks: Arena Chaos, Quick Draw, Animal Antics, Food Fight, Screen Time, Loud Icons, Wish You Were Here, Web3 Nonsense and Mythical Mess.

## Milestone 2 — Solo Studio and Vault

- [x] New artwork control with a destructive-action confirmation when marks exist.
- [x] Save-to-Vault confirmation offers Start Fresh or Open Vault.
- [x] Fresh artwork resets title, layers and storefront package without deleting saved work.
- [x] Professional free toolset, formats, dark UI, 8 essential colours, 24 custom colours and 12 non-destructive layers.
- [x] Eleven genuinely distinct brush renderers: pressure graphite, tapered ink, stacking marker, particle airbrush, fibrous charcoal, technical line, layered watercolor, grainy pastel, snapped pixels, ribbon calligraphy and bright-core neon.
- [x] Equipped pass brushes change the real Studio renderer and export treatment—not just the button colour or item name.
- [x] Layer add, select, rename, show/hide, solo/show-all, reorder, duplicate, lock, opacity, blend and trash controls.
- [x] Account recovery and passkey path for durable cross-device Vault ownership.

## Milestone 3 — Season, rewards and player economy

- [x] Season XP, levels, achievements, cosmetics, equipment and free/premium Panic Pass entitlement tracks.
- [x] Call-of-Duty-style dual lanes share one XP bar: Free remains worthwhile, Premium adds only cosmetics and Mint Credits, never competitive power.
- [x] Every Season 0 beta account permanently reserves a free Season 1 Premium Panic Pass as a Founding Weirdo reward.
- [x] A repeat-safe PostgreSQL migration reserves that entitlement for existing offline beta accounts; runtime provisioning covers every new Season 0 account.
- [x] Season 0 Premium contains a full 10-reward lane, including working Riot Marker, Neon Panic and Chaos Charcoal Studio brushes.
- [x] First Panic Archive mint is an immediate welcome entitlement, not a fake random loot claim.
- [x] Reward Inbox is notification/history; rewards are usable as soon as they are earned.
- [x] Individual grants, audited global thank-you drops, free-mint credits, percentage discounts and capped promo codes.
- [x] Backstage roles, audit trail, player ledger, promotion controls, moderation and contract access transaction preparation.
- [x] Durable weekly, monthly, Season 0 and all-time leaderboards driven only by completed authoritative matches.
- [x] Transparent Chaos Score: completion, crowns, correct guesses, fastest solve and completed drawing turns; abandoned games and guess spam earn nothing.
- [x] Equal scores and wins share rank. The game never breaks a leaderboard tie with a hidden random choice.
- [x] Badges/achievements plus usable avatars, brushes, reactions, player titles and profile frames.
- [x] Weekly prize schedule (badges + XP) and monthly prize schedule (badges + Mint Credits), with a Backstage preview and explicit admin confirmation.
- [x] Idempotent match receipts and prize campaign keys prevent replayed match events or repeated admin clicks from duplicating rewards.
- [ ] Paid premium Panic Pass checkout remains a later commerce milestone; no price/provider has been approved.

The Panic Pass is the seasonal progression track. Players earn XP through complete matches and unlock visible, usable identity rewards and occasional Mint Credits. Premium adds a parallel cosmetic/reward lane but never improves score, drawing tools, guessing power or leaderboard position.

## Milestone 4 — Panic Archive minting

- [x] One permanent collection with seasonal metadata: Sketch Arena: The Panic Archive.
- [x] First mint free; subsequent fee is the live WSHIDO equivalent of USD $0.99.
- [x] Exact WSHIDO approval, signed 15-minute voucher, one-time nonce and three-confirmation verification.
- [x] Five-percent ERC-2981 royalty goes to the original minting artist; the existing marketplace independently charges its 2.5% platform fee.
- [x] Collection allowlist/blocklist policy and signer rotation controls.
- [x] Dedicated voucher signer stored only on the protected VPS.
- [x] Public collection-level metadata endpoint for the contract and marketplace indexer.
- [x] Contract compile and disposable-chain adversarial suite.
- [x] Deployed the collection from the approved owner wallet, configured the live address and independently verified the exact runtime, roles, policy and one **paid** mainnet canary. The free-mint entitlement path remains covered by automated tests but was not the canary used on-chain.
- [x] Added a two-stage Backstage deployment review using the checked-in artifact, exact approved roles and owner-wallet-only signing. The collection constructor starts paused.
- [x] Verified the compiled artifact against Shido mainnet: Paris EVM target, chain 9008, live WSHIDO identity/code, owner gas balance and successful 3,469,589-gas deployment estimate. This caught and removed an incompatible Shanghai `PUSH0` artifact before deployment.

## Milestone 5 — Production release

- [x] PostgreSQL-backed production domains, migrations, health endpoints, structured logs, backup verification and systemd/Nginx deployment shape.
- [x] Browser smoke coverage for entry, Lobby, nine-deck setup, Studio controls, save/start-fresh and Vault persistence.
- [x] Automated lint, production builds, server/web tests, operations tests and contract tests.
- [x] Production PostgreSQL backup restored into an isolated temporary database, validated across every durable domain and removed without granting the application database-creation privilege.
- [x] Push the leaderboard/reward/pass release and deploy only `/opt/sketch-arena/current`.
- [x] Confirm the live release SHA and health for the isolated production release; automated primary-flow and responsive gates pass on the same source.
- [x] Verify the deployed collection, paid canary receipt, public Archive indexing, NFTStudio collection approval and public indexer handoff. Exact evidence lives in `PANIC_ARCHIVE_MAINNET_EVIDENCE.md`.
- [ ] Complete a physical Android/iOS wallet, passkey, keyboard and gesture matrix plus an independent Solidity/security review before removing the beta label.

No milestone may describe a wallet transaction, mint or marketplace listing as complete until its on-chain receipt has been independently verified.
