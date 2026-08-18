# Sketch Arena Reborn

A server-authoritative social drawing game with public/private rooms, live strokes, timed hints, scoring, reactions, reconnect protection, round reveals, an afterparty gallery, Solo Studio, and a durable Artwork Vault.

Public-room safety includes host removal with room-level re-entry prevention and a private player-report flow. Reports resolve server-authoritative room identities, are rate-limited and deduplicated, and enter a protected Backstage queue where named operators record review decisions without exposing the report to the room.

The current requirement-by-requirement release decision and external NFT handoff are tracked in [`RELEASE_READINESS.md`](./RELEASE_READINESS.md).
The contract review package and unresolved deployment parameters are tracked in [`PANIC_ARCHIVE_AUDIT_HANDOFF.md`](./PANIC_ARCHIVE_AUDIT_HANDOFF.md).
The fail-closed USD Premium Panic Pass sale design and remaining provider evidence are tracked in [`BATTLE_PASS_COMMERCE.md`](./BATTLE_PASS_COMMERCE.md).

Blockchain calls are intentionally behind a clean boundary. The product works without a wallet. The Vault now supports wallet ownership proof, immutable IPFS preparation, EIP-712 Panic Archive vouchers, browser transaction submission, and server-verified confirmation when—and only when—the real production configuration is present.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The API and realtime game server run on port `4100`.

Backstage is available at `http://localhost:5173/backstage`. Set a private server-only key before starting local development (use at least 32 random characters):

```powershell
$env:ADMIN_API_TOKEN = "replace-with-a-long-random-development-key"
npm run dev
```

The key is never bundled into the web app. The Backstage unlock screen keeps it only for the current browser tab. Production must replace the single compatibility key with `BACKSTAGE_CREDENTIALS`: a JSON array of named staff entries containing a SHA-256 token hash and a `viewer`, `operator`, or `admin` role. Viewers can inspect health and ledgers, operators can grant individual rewards, and only admins can execute global campaigns. With `REQUIRE_BACKSTAGE_CREDENTIALS=true`, malformed JSON, duplicate staff names, reused tokens, missing named principals, or an unapproved production `ADMIN_API_TOKEN` make the server refuse startup rather than silently weakening access control.

```bash
npm run check
npm run qa:load
npm run db:migrate
npm run db:import:legacy
npm run contract:compile
npm run contract:test:ci
```

`npm run check` is the normal application release gate: strict ESLint, every workspace production build, server unit tests, the real Socket.IO lifecycle integration test, and web wallet-error tests. The browser QA record in `PRODUCT_AUDIT.md` additionally covers the actual entry, lobby, match/afterparty, Vault, Archive and responsive Studio flows.

`npm run qa:load` launches the compiled server on a disposable loopback port, fills four eight-player rooms with real Socket.IO clients, generates acknowledged chat/reaction fan-out, checks protected metrics, and fails on action errors, missing broadcasts, metrics drift, or a p95 latency above its budget. It refuses non-loopback targets unless `ALLOW_REMOTE_LOAD_TEST=true` is deliberately supplied. A 96-player/12-room local stress run is recorded in `RELEASE_READINESS.md`; staging must still prove the real network and host size.

`npm run db:import:legacy` is a first-cutover tool, not a normal startup task. With the old service stopped, it imports any configured JSON adapters into PostgreSQL inside one advisory-locked transaction, preserves IDs/audits, records every source SHA-256, skips an identical rerun and rejects a source that changed after import. Back up both sides before using it; the immutable sequence is in `deploy/RELEASE_CHECKLIST.md`.

The contract compile is verification only and never deploys. Solidity, Ethers, OpenZeppelin and the ephemeral Hardhat chain are pinned development dependencies of this repository, so a clean checkout can reproduce the contract evidence without borrowing packages from NFTVault.

`npm run contract:test:ci` starts a throwaway Hardhat chain, runs the adversarial harness, and shuts the chain down. The harness deploys only to that ephemeral chain and uses Hardhat's publicly known test accounts. `npm run contract:test:live` remains available when a local JSON-RPC test node is already running on `127.0.0.1:8546`.

## Production shape

- Serve `apps/web/dist` as static files through Nginx.
- Run `apps/server/dist/index.js` as a supervised Node process.
- Proxy `/api`, `/health`, and `/socket.io` to `127.0.0.1:4100`; WebSocket upgrade headers are required.
- Use `/health/live` for process liveness and `/health/ready` for traffic readiness. Readiness becomes `503 draining` as soon as graceful shutdown begins.
- Set `WEB_ORIGIN=https://your-sketch-arena-domain` and keep `BIND_HOST=127.0.0.1` behind Nginx.
- Set `RELEASE_SHA` to the exact deployed Git commit. `/health/live` and `/health/ready` expose it so smoke tests can prove which source is running.
- Keep `TRUST_PROXY=loopback` for the supplied same-host Nginx layout so rate limits use the real forwarded client IP without trusting arbitrary internet proxies.
- Production stores Vault artwork and mint metadata in PostgreSQL. `ARTWORK_DATA_FILE` remains the zero-infrastructure development adapter; rendered IPFS media remains in private object/IPFS storage rather than inside the database.
- Production stores Season progress, Mint Credits, items, achievements, premium passes, reward acknowledgements, global idempotency keys and the Backstage audit trail in PostgreSQL. `PROGRESSION_DATA_FILE` is a local-development adapter.
- Production stores wallet challenges, verified bindings, signed voucher reservations, transaction hashes and confirmation state in PostgreSQL with single-use and ownership constraints. `MINT_DATA_FILE` remains the local-development adapter.
- Production stores promotion campaigns/redemptions and their audit trail in PostgreSQL. Promo codes remain high-entropy, SHA-256-only, capped, expiring, pausable and limited to one redemption per player; the raw code is returned to an admin exactly once. `PROMOTION_DATA_FILE` is development-only.
- Production stores private player reports and named staff resolutions in PostgreSQL with duplicate-window locking and status indexes. `REPORT_DATA_FILE` is development-only.
- `ACCOUNT_DATA_FILE` is a development fallback. It stores only hashed legacy credentials, hashed expiring device sessions, passkey public material/counters and short-lived challenges—never raw recovery keys or session tokens.
- Set `DATABASE_URL` and run `npm run db:migrate`; the checksum-tracked, advisory-locked runner applies `deploy/postgres` exactly once and rejects migration drift. The server refuses production startup without PostgreSQL or when it is unavailable. Accounts/passkeys, Vault artwork, wallet ownership, voucher/mint state, progression, promotions and moderation all use one shared production database pool. JSON adapters exist only for zero-infrastructure local development.
- Set `PASSKEY_ORIGIN=https://sketch.bodhix.io` and `PASSKEY_RP_ID=sketch.bodhix.io` exactly. HTTPS is required outside localhost.
- Set `SKETCH_BACKUP_DIR` to a separate protected volume and install PostgreSQL client tools. `npm run ops:backup:postgres` creates a restrictive custom-format `pg_dump`, hashes it, and proves it can be listed by `pg_restore`; the database URL is passed through the environment and never exposed in process arguments. `npm run ops:backup:postgres:verify -- <directory>` rechecks the manifest and dump. `npm run ops:backup` remains available only for development/file-adapter migration snapshots. Production additionally needs scheduled off-host replication, retention and PITR.
- Do not rely on `ADMIN_API_TOKEN` in production. Provision named hashed `BACKSTAGE_CREDENTIALS`; production starts fail-closed unless the legacy override is explicitly enabled for a controlled migration.
- Prefer named, hashed `BACKSTAGE_CREDENTIALS` in production so operator actions identify the staff principal and enforce viewer/operator/admin boundaries. Never store raw staff tokens in that JSON.
- Set an independent `METRICS_TOKEN` and scrape `http://127.0.0.1:4100/metrics` from the host collector. The endpoint exports readiness, uptime, active rooms/connections, HTTP/socket failure counters, rate limits, memory and the release SHA. The supplied Nginx configuration denies public access to it.
- Rooms are intentionally in-memory today. A server restart ends active matches. Redis-backed room snapshots are the next infrastructure step if zero-downtime match recovery is required.
- The Studio keeps all professional controls reachable on phones: its mobile workspace dock opens format, brush/color and layer panels without shrinking the drawing surface.

Production-ready starting points are included in `deploy/nginx-sketch-arena.conf.example`, `deploy/sketch-arena.service.example`, and the PostgreSQL backup service/timer examples. Replace the example host/certificate paths, store secrets in `/etc/sketch-arena/server.env`, provision PostgreSQL plus a separate protected backup volume, and install `pg_dump`/`pg_restore`. Production startup rejects missing or unavailable PostgreSQL. The server emits one-line JSON logs with request IDs and lifecycle events for journal/collector ingestion; it never writes wallet credentials, voucher signing keys, promo codes, session tokens or Vault recovery keys to logs.

## Shido / NFT Studio integration boundary

`ArtworkDocument` in `packages/protocol` is the handoff contract. Arena keeps and Studio prepares both land in the same Vault format: owner session, provenance, dimensions, normalized strokes, status, and confirmed mint metadata. The implemented gated lifecycle:

1. asks for a five-minute, single-use, gasless wallet signature and binds that wallet to the authenticated Vault owner;
2. server-renders the canonical SVG and pins both media and public-safe metadata through the private Kubo API;
3. reserves one available Mint Credit, or applies the configured standard native-token price, then signs an exact recipient/URI/artwork/price/nonce/expiry voucher;
4. asks the wallet to redeem that voucher directly against the one Panic Archive collection;
5. independently reads the Shido receipt and matching `PanicArchiveMinted` event before consuming a Mint Credit or marking the artwork minted;
6. creates a marketplace link only from an explicitly configured, verified token URL template.

The live collection is **Sketch Arena: The Panic Archive**, with seasons represented inside one permanent collection (Season 0: **The First Mess**). Mint Credits, Battle Pass rewards and signed-voucher eligibility are resolved server-side, while the player submits the signed redemption from their own wallet. The server still fails closed with `503` whenever required production configuration is incomplete. The deployed address and independently rechecked evidence live in `PANIC_ARCHIVE_MAINNET_EVIDENCE.md`.

Backstage can issue direct Mint Credits, percentage-discount entitlements, individual rewards, preview-confirmed global drops, and redeemable promo campaigns. Discounts never alter the transaction in the browser: the server resolves the best valid benefit and signs the final reduced voucher price. Promo redemption is rate-limited and does not require a wallet.

Admins can also prepare allowlist, blocklist, and global allowlist-policy transactions. Those controls are deliberately owner-wallet operations: Backstage produces the exact contract call, the injected owner wallet displays it for approval, and the wallet submits it. Sketch Arena never stores the owner key or reports a policy change as final until the chain confirms it. These emergency controls need only the deployed contract address, chain configuration, and wallet RPC URLs, so they remain usable if the voucher signer or IPFS service is temporarily unavailable.

The public collection lives at `http://localhost:5173/archive`. Its `/api/archive` feed is intentionally anonymous and confirmed-only: drafts, pending transactions, failed mints, wallet bindings, and private player/session identifiers are excluded. A trophy links to the configured marketplace and chain explorer only when those exact production destinations are available.

No royalty, contract address, API route, or marketplace indexing promise is assumed by this repository. Those values must come from NFTStudio's verified deployment configuration before a direct adapter is enabled.

## Security notes before public launch

Existing Vaults retain their credential-derived UUID during account migration, so artwork, rewards, passes, reports and mint records do not split. The browser exchanges the legacy credential for an expiring HttpOnly SameSite device session; the server stores only hashes. Players can add discoverable, user-verifying passkeys and sign in on another device without a wallet. The emergency `SKETCH-VAULT-V1-…` key stays hidden by default, restoration requires a second confirmation and revokes the current browser session first. Wallet binding uses a separate server-created, expiring, single-use challenge. The voucher signer remains server-only, and the server—not the browser—decides whether a Mint Credit applies. Put TLS and request limits at Nginx, back up every data store, add error monitoring, and keep the Kubo API private. Never place the voucher signing key in a Vite/public variable.
