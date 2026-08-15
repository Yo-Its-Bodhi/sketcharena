# Sketch Arena Reborn

A server-authoritative social drawing game with public/private rooms, live strokes, timed hints, scoring, reactions, reconnect protection, round reveals, an afterparty gallery, Solo Studio, and a durable Artwork Vault.

Blockchain calls are intentionally behind a clean boundary. The product works without a wallet; the later Shido/NFT Studio adapter only needs to consume the canonical artwork documents already produced by Arena and Studio.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The API and realtime game server run on port `4100`.

```bash
npm test
npm run build
```

## Production shape

- Serve `apps/web/dist` as static files through Nginx.
- Run `apps/server/dist/index.js` as a supervised Node process.
- Proxy `/api`, `/health`, and `/socket.io` to `127.0.0.1:4100`; WebSocket upgrade headers are required.
- Set `WEB_ORIGIN=https://your-sketch-arena-domain` and keep `BIND_HOST=127.0.0.1` behind Nginx.
- Point `ARTWORK_DATA_FILE` at a backed-up persistent volume. The JSON adapter is safe for one server instance; replace it with Postgres/object storage before horizontal scaling.
- Rooms are intentionally in-memory today. A server restart ends active matches. Redis-backed room snapshots are the next infrastructure step if zero-downtime match recovery is required.

## Shido / NFT Studio integration boundary

`ArtworkDocument` in `packages/protocol` is the handoff contract. Arena keeps and Studio prepares both land in the same Vault format: owner session, provenance, dimensions, normalized strokes, status, and optional mint metadata. The future adapter should:

1. authenticate the wallet and bind it to the current owner;
2. render/upload immutable media and metadata;
3. submit the Shido mint transaction;
4. update `mint.tokenId`, `transactionHash`, and `marketplaceUrl` only after confirmation;
5. deep-link the completed item into `nftstudio.bodhix.io`.

Do not charge a separate Sketch Arena mint fee at launch. Let users create and mint freely apart from network cost, then monetize through the existing 2.5% marketplace royalty. It keeps the fun loop frictionless and aligns revenue with actual value changing hands.

## Security notes before public launch

Move identity from local session UUIDs to signed wallet/session tokens before enabling minting or destructive Vault actions. Put TLS and request limits at Nginx, back up artwork storage, add error monitoring, and run a dependency/security scan on the VPS image. The current endpoints intentionally cannot mint, transfer, sell, or delete assets.
