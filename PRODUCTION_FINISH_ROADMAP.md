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
- [x] Layer add, select, rename, show/hide, solo/show-all, reorder, duplicate, lock, opacity, blend and trash controls.
- [x] Account recovery and passkey path for durable cross-device Vault ownership.

## Milestone 3 — Season, rewards and player economy

- [x] Season XP, levels, achievements, cosmetics, equipment and free/premium Panic Pass entitlement tracks.
- [x] First Panic Archive mint is an immediate welcome entitlement, not a fake random loot claim.
- [x] Reward Inbox is notification/history; rewards are usable as soon as they are earned.
- [x] Individual grants, audited global thank-you drops, free-mint credits, percentage discounts and capped promo codes.
- [x] Backstage roles, audit trail, player ledger, promotion controls, moderation and contract access transaction preparation.
- [ ] Paid premium Panic Pass checkout remains a later commerce milestone; no price/provider has been approved.

## Milestone 4 — Panic Archive minting

- [x] One permanent collection with seasonal metadata: Sketch Arena: The Panic Archive.
- [x] First mint free; subsequent fee is the live WSHIDO equivalent of USD $0.99.
- [x] Exact WSHIDO approval, signed 15-minute voucher, one-time nonce and three-confirmation verification.
- [x] Five-percent ERC-2981 royalty goes to the original minting artist; the existing marketplace independently charges its 2.5% platform fee.
- [x] Collection allowlist/blocklist policy and signer rotation controls.
- [x] Dedicated voucher signer stored only on the protected VPS.
- [x] Public collection-level metadata endpoint for the contract and marketplace indexer.
- [x] Contract compile and disposable-chain adversarial suite.
- [ ] One irreversible gate remains: deploy the reviewed collection from the approved owner wallet, then configure its address and run one free-mint canary on Shido mainnet.
- [x] Added a two-stage Backstage deployment review using the checked-in artifact, exact approved roles and owner-wallet-only signing. The collection constructor starts paused.

## Milestone 5 — Production release

- [x] PostgreSQL-backed production domains, migrations, health endpoints, structured logs, backup verification and systemd/Nginx deployment shape.
- [x] Browser smoke coverage for entry, Lobby, nine-deck setup, Studio controls, save/start-fresh and Vault persistence.
- [x] Automated lint, production builds, server/web tests, operations tests and contract tests.
- [ ] Push the audited commit and deploy only `/opt/sketch-arena/current`.
- [ ] Confirm the live release SHA, health, primary UI paths and mobile layout.
- [ ] After contract deployment: verify one free canary mint, one paid quote without submission, public Archive indexing and NFTStudio marketplace handoff.

No milestone may describe a wallet transaction, mint or marketplace listing as complete until its on-chain receipt has been independently verified.
