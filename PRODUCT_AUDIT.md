# iSketch production audit

Audit date: 2026-08-16

Scope: current React/Vite client, authoritative Socket.IO game server, shared protocol, local artwork repository, desktop/mobile presentation, and the publicly described NFTStudio handoff boundary.

## Current top-to-bottom verification pass

The 2026-08-16 release-candidate pass reran lint, production builds, all always-on application and operations tests, the real Socket.IO lifecycle suite, the 32-client load harness, production dependency advisories, contract compilation and the disposable-chain adversarial contract harness. The load run completed 256 acknowledged actions with zero failures at 21.3 ms p95; npm reported zero production vulnerabilities; the contract remained 14,731 deployed bytes and passed its local-chain matrix.

The browser pass covered desktop entry, Lobby, room configuration, real two-client live play, drawer chat lock, a 620-point continuous Arena gesture, Studio formats/tools/colors/layers/dark UI, Studio autosave, Studio-to-Vault persistence, fail-closed minting, authenticated Vault recovery, the honest empty Archive, Backstage authentication lock, and 390×844 Archive/Studio/Backstage layouts with a clean browser console.

Four issues were found and remediated during this pass:

- Arena accepted 500 client points while the server silently rejected more than 250; final saves also competed with preview traffic. Long gestures are now seamlessly segmented against a shared protocol limit, previews have an independent budget, and final saves are acknowledged.
- Studio kept long gestures locally but the Vault API rejected them. Studio now normalizes both current and legacy freehand strokes before creating the canonical Vault package.
- Studio reported a healthy server as offline after validation failure, and a pending autosave could overwrite successful Vault feedback. Failures are now honest and explicit; successful Vault feedback is protected long enough to be visible.
- The mobile Backstage lock overflowed horizontally and the live-match helper expired before a legitimate cap-length game. The lock now fits 390px viewports and the helper has a bounded six-minute default.

The application can ship as a non-minting, fail-closed game release once the exact commit passes GitHub CI and the PostgreSQL/VPS cutover checklist. Paid Battle Pass checkout, contract deployment, live Shido voucher redemption and NFTStudio indexing remain external approval/infrastructure gates and must not be represented as complete.

## Panic Archive storefront

- One permanent collection: **Sketch Arena: The Panic Archive**.
- Seasonal gallery identity begins with **Season 0: The First Mess**.
- The public archive exposes only confirmed mint outcomes and never publishes private Vault/session ownership data.
- Token receipts provide contract and transaction proof, canonical IPFS metadata status, a shareable Panic number, and exact configured marketplace/explorer handoffs.
- Empty states are honest: the interface never invents collection volume or placeholder mints.

## Remediation status

The original P0 findings below are retained as the audit record. The current working tree now binds every room action to the active socket, protects replacement reconnects, blocks drawer chat during drawing, authenticates Vault ownership from a private credential, makes round saves idempotent, pauses required-player disconnects, visibly shields live play during a local network wobble, and keeps minting behind an honest integration boundary. Regression coverage is in place for these paths, including a real two-client Socket.IO lifecycle test that covers duplicate-tab replacement, stale actions, stale disconnect safety and host migration.

Season 0 progression is also live: first-mint credits, percentage-discount entitlements, XP, achievements, items, premium-pass entitlements, reward acknowledgements, persistent player profiles, idempotent campaigns, and operator audit entries. The protected `/backstage` control room supports named viewer/operator/admin credentials, individual grants, preview-confirmed admin-only global drops, capped/expiring/pausable hashed promo codes, mint configuration health, wallet counts, and a redacted mint-operations ledger. Player-controlled Vault recovery keys are now available with hidden-by-default backup and two-step restoration. Every durable production repository now has a PostgreSQL adapter and constrained schema; live provisioning/PITR, multi-party approval workflows, monitored recovery support, and independent contract review remain pre-deployment work.

The Panic Archive integration is now implemented behind a fail-closed configuration gate: five-minute wallet challenges, durable wallet bindings, canonical SVG and metadata pinning, exact EIP-712 vouchers, one-unit Mint Credit reservation, encoded wallet redemption, resumable transaction state, independently classified wallet/RPC/revert failures, and independent receipt/event verification. No contract has been deployed, no signer is present locally, and the UI truthfully remains locked until reviewed production values are supplied.

Manual browser QA completed on 2026-08-16 against the running local client/server. It covered the entry and lobby, a genuine two-player/two-round match, correct guesses, match completion, afterparty gallery enlargement, SVG download controls, owned-trophy save-to-Vault, confirmed Vault appearance, keyboard-visible dialog focus, Escape dismissal, phone-width Archive and Studio layouts, and a clean browser console. The responsive Studio now exposes format presets, the full brush/color panel and non-destructive layers through a four-way mobile dock rather than hiding professional controls.

The production operations pass now adds separate liveness/readiness probes, an immediately observable draining state, idempotent shutdown coordination, fatal-process handling, correlated one-line JSON request/lifecycle logs, and a tested same-host proxy trust boundary so Nginx users do not share one rate-limit identity. Example hardened Nginx and systemd configurations are included under `deploy/`.

The contract-admin completion audit corrected and regression-tested the exact `setRecipientApproved(address,bool)` selector used by Backstage. All three prepared owner-wallet actions—recipient block, recipient approval and global allowlist policy—are now decoded in tests against the Solidity contract’s real function names rather than assumed from UI labels.

## What is already strong

- The server owns prompts, timers, scores, hints, turns, stroke acceptance, and match completion.
- Realtime draw previews and canvas-control events have a separate per-socket rolling budget, preventing a modified client from turning pointer traffic into a room-wide broadcast flood.
- The core create/join/draw/guess/reveal/rematch loop exists and the current unit suite passes.
- Guessers do not receive the prompt before reveal; drawing previews are capped and committed server-side.
- The visual identity already reads as a party drawing game rather than a generic Web3 dashboard.
- Mobile uses a canvas-first shell with dedicated player/chat drawers instead of crushing the desktop grid.
- Artwork persistence is behind a repository interface, and blockchain operations are not faked.
- Production dependencies currently report zero known npm advisories.

## P0 — release blocking

1. **A replaced socket can invalidate the live socket.** Session resumption replaces `player.socketId`, but a later disconnect from the old tab marks the player offline. Old sockets also retain the session closure and room subscription. Reproduced with real Socket.IO clients.
2. **Socket actions are not bound to the active socket.** A stale tab holding the same session UUID can attempt room, guess, chat, reaction, and drawing actions after a replacement connection.
3. **The drawer can leak the answer through chat.** During a drawing round, the drawer can submit the exact prompt via `chat:send`; it is broadcast to every guesser. Reproduced end to end.
4. **Artwork identity is not authenticated.** Vault list/save APIs trust a caller-supplied session UUID. This is acceptable only for local prototyping and blocks destructive actions, ownership claims, wallet binding, or minting.
5. **Keeping a round is not idempotent.** The room records a kept ID but does not reject or return an existing save; repeated requests can create duplicate artwork documents. This must be fixed before any mint workflow.
6. **Original finding—no legitimate mint/marketplace implementation existed.** This has been remediated at the application boundary with the gated Panic Archive contract, wallet/voucher/IPFS/confirmation lifecycle and explicit marketplace URL template. Deployment, independent review, collection approval and live indexer verification intentionally remain external release gates.

## P1 — major experience and reliability issues

- Active-match recovery is memory-only. A server restart ends every room, and reconnect restores room state but not the social feed.
- Remediated: required-player disconnects pause the active round, the seat is held for the reconnect window, and the disconnected browser blocks live input behind an automatic reconnect shield.
- Remediated: actionable socket acknowledgements surface human-readable errors for start, ready, guess/chat, reaction, rematch, save and leave failures.
- Remediated: room setup includes privacy, prompt deck, player cap, rounds per player and 30/45/60-second choices; non-host players have ready state and arrivals are visible in the live feed.
- Remediated: the countdown has calm/pressure/urgent/panic/critical presentation stages plus audio cues and a persistent mute preference.
- Remediated: the arena mixer exposes persistent mute and volume controls without occupying permanent gameplay space; the volume slider appears on hover/focus and remains keyboard/mobile accessible.
- Remediated: correct guesses receive placement, score and feed feedback while the drawer sees real-time solver status.
- Remediated: reveals include fastest solver, score gains, success rate, funny/near guesses, reactions and owned-round save framing.
- Remediated: the afterparty gallery enlarges every trophy, supports reactions and SVG download, and lets the original drawer idempotently save the exact round before opening its Vault mint handoff.
- `App.tsx` owns nearly every screen and workflow; continued feature work will become risky without extraction.

## P2 — polish, accessibility, and performance

- Remediated: the countdown samples deadlines frequently enough to cross second boundaries reliably but returns the existing state between changes, so React rerenders the arena only when the displayed second actually changes.
- Remediated: the Studio renderer caches immutable layer surfaces and reuses one active-stroke preview surface, preserving blend/eraser semantics without reallocating and repainting every layer on each pointer move.
- Remediated: dialogs and reveal overlays use modal semantics, labelled titles, initial focus, focus trapping, Escape dismissal and focus restoration.
- Some status information is primarily visual; screen-reader announcements need prioritization to avoid noisy live regions.
- CSS remains large and should be modularized with the screen extraction work; the previously invalid safe-area declaration has been removed and patch hygiene is checked before handoff.
- Strict ESLint, server unit coverage, a real Socket.IO integration suite and web wallet-error tests are now release gates. Structured server/request logging and supervisor-friendly health probes are implemented. Automated browser integration and an external error-monitoring adapter remain production operations work.
- Remediated across the primary flows: loading, offline/rejoining, clipboard failure, wallet rejection, RPC failure and server-unavailable states now use explicit human-readable UI. Continue adding route-specific failure tests as screens are extracted.
- Remediated: closing the mint sheet cancels outstanding confirmation timers and suppresses late state updates; preparation and transaction submission also use immediate in-memory locks so rapid clicks cannot create duplicate wallet prompts before the disabled UI renders.

## P3 — future, not launch blockers

- Spectators, AFK detection, kick controls, post-round voting, rivalries, and richer public player profiles. Achievement and Season XP foundations are now implemented.
- Persistent match history, share cards, gallery favorites, and replay playback.
- Horizontal scaling with Redis room snapshots and Postgres/object storage.
- Wallet ownership, Shido minting, and marketplace indexing only after the actual NFTStudio contract/API/indexer boundary is available and authenticated.

## Delivery order

1. Bind actions/disconnects to the active socket, block answer leakage, and make keeps idempotent.
2. Add regression and real-socket integration coverage for lifecycle, reconnect, guessing, and abuse cases.
3. Improve reconnect/offline/action feedback and staged countdown/audio hooks.
4. Upgrade lobby, reveal, afterparty, social presence, responsive behavior, and accessibility.
5. Harden artwork authorization behind a signed server session; do not imply wallet ownership before wallet authentication exists.
6. Integrate NFTStudio only from verified contracts/APIs/source, then add mint state-machine and marketplace indexing tests.
