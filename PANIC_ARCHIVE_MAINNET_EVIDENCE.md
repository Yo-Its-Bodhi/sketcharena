# Panic Archive mainnet evidence

Verified: 2026-08-18

This is the canonical live-deployment record for **Sketch Arena: The Panic Archive**. It supersedes older planning text that described the collection as undeployed. It is evidence of the deployed configuration and first real mint; it is not a substitute for an independent Solidity audit.

## Live addresses

| Role | Address |
| --- | --- |
| Panic Archive collection | `0x80E81dE12b1412B74475C9354d092091Da4Ea334` |
| Owner/admin | `0xA9E8a36E648E2C5DDc53D9942b88a158B7789E4e` |
| Voucher signer | `0x44A5920654B1D6DFDC92E201514F1389e6dAc3e7` |
| Treasury/payout receiver | `0xAe0CEb4Bc23Dfdd552eaE2865481B191C3b28da1` |
| WSHIDO payment token | `0x8cbaffd9b658997e7bf87e98febf6ea6917166f7` |
| NFTStudio marketplace V2 | `0x19ee7a8D5Ee19c38d1754290b483BE6f4483e9d6` |

## Verified collection state

- Shido chain ID: `9008`.
- Collection identity: `Sketch Arena: The Panic Archive` / `PANIC`.
- The deployed runtime matches the checked-in Paris-targeted artifact after normalizing compiler-recorded immutable slots.
- Source SHA-256: `e5ab07960b07fc53cb09ffec57cd4661dc1c42b511441d821d9f64a846740fe1`.
- Normalized runtime SHA-256: `d2bb8cadf428b488f450ddd9f8e43c316d39395c51f390e9a002e7d9c70c9180`.
- Runtime size: `14,381` bytes.
- Minting is open and the contract is not paused.
- Supply and voucher-price caps are `type(uint256).max`; exact short-lived signed prices remain the user spend boundary.
- The collection metadata URI is `https://sketch.bodhix.io/api/archive/metadata`.
- The allowlist is optional; wallet block/approve policy remains owner-controlled.
- ERC-2981 royalty is `500` bps and remains payable to each token's original minting artist after transfer.

## First confirmed token

| Field | Evidence |
| --- | --- |
| Token | `PANIC #1` |
| Transaction | `0xa96aab28271abd2163ec976584914916fae5e333d3da2c287e39f9ac10c1a080` |
| Block | `40556097` |
| Original artist / recipient | `0xA9ef56a00036E37C1aA3567E0082a415283893Ed` |
| Current owner | `0x19ee7a8D5Ee19c38d1754290b483BE6f4483e9d6` |
| Token metadata | `ipfs://bafkreih25ynexthgxly55ecehab5sqffi4iuqtmah3bszu5ec2iiu5xnga` |
| Price paid | `6934715606612496497619` WSHIDO base units |
| Royalty receiver after transfer | `0xA9ef56a00036E37C1aA3567E0082a415283893Ed` |
| Royalty result for a 10,000-unit sale | `500` units (5%) |

The first confirmed mint was a **paid** canary, not a free canary. It must not be relabelled as a first-mint-free test. The token's current owner is the NFTStudio marketplace contract, consistent with marketplace custody/listing, while the original artist remains the royalty receiver.

## NFTStudio handoff

- Marketplace collection approval for the Panic Archive is `true` on-chain.
- NFTStudio's public indexer returns the collection as **The Panic Archive**.
- Indexed slug: `onchain-80e81de12b1412b74475c9354d092091da4ea334`.
- Collection URL: `https://nftstudio.bodhix.io/collections/onchain-80e81de12b1412b74475c9354d092091da4ea334`.
- Indexed token ID format: `onchain-80e81de12b1412b74475c9354d092091da4ea334-{tokenId}`.
- PANIC #1 metadata is publicly retrievable from the configured NFTStudio IPFS gateway and identifies the creator as `Bodhi`, Season 0, Solo Studio and the 2400 × 2400 canvas.
- The metadata's referenced PNG is independently retrievable from the same gateway (`763,700` bytes at verification time).

## Reproduce the contract and canary verification

```bash
npm run contract:verify:mainnet -- 0x80E81dE12b1412B74475C9354d092091Da4Ea334 --state live-canary --canary-tx 0xa96aab28271abd2163ec976584914916fae5e333d3da2c287e39f9ac10c1a080 --token-uri ipfs://bafkreih25ynexthgxly55ecehab5sqffi4iuqtmah3bszu5ec2iiu5xnga --price 6934715606612496497619
```

The command exits non-zero if any checked role, immutable, runtime, collection state, receipt, event, price, metadata or royalty invariant differs.

## Remaining external assurance

- Independent Solidity review and any requested extended fuzzing remain outstanding.
- Marketplace purchase/cancel/settlement behavior belongs to the NFTStudio marketplace release and should retain its own receipt-level test evidence.
- Signer rotation, owner recovery, incident response and production monitoring need recurring operational drills.
