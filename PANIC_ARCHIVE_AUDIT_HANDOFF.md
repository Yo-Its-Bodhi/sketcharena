# Panic Archive independent security-review handoff

Status: ready to submit for independent review; not deployed and not approved for funds.

This document fixes the intended review boundary for `SketchArenaPanicArchive.sol`. The final auditor package must reference the immutable Git commit produced by the release workflow. Any source change after that commit invalidates the review scope until the auditor accepts the diff.

## Review scope

| Item | Pinned value |
| --- | --- |
| Contract | `contracts/SketchArenaPanicArchive.sol` |
| Current source SHA-256 | `5896994b62c69aabf705a534ad763d1ab4b8ef15754335c906a7b5aa91983459` |
| Adversarial harness | `scripts/test-panic-archive.mjs` |
| Current harness SHA-256 | `8ef9a7f2b02cb8133b0de24ab5054366a383fc490e28b1f50b504aef7250b088` |
| Compiler | Solidity `0.8.26` |
| Optimizer | enabled, 200 runs |
| OpenZeppelin | `@openzeppelin/contracts@4.9.6` |
| Ethers | `6.15.0` |
| Local chain | Hardhat `3.13.0`, chain ID `31337` |
| Optimized deployed size | 14,731 bytes |
| Intended production chain | Shido EVM, chain ID `9008` |

Recalculate both hashes from the submitted release commit. A mismatch is a review stop, not a warning.

## System purpose and trust boundary

The contract is one permanent ERC-721 collection for Sketch Arena trophies. The game server evaluates private eligibility—Mint Credits, discounts, promotions, Battle Pass and achievements—and a dedicated signer produces an EIP-712 voucher. The player submits that voucher directly from the recipient wallet and pays the exact signed native-token price.

The voucher signer is trusted to authorize price, recipient and public metadata commitments. It must have no ownership or withdrawal authority. The collection owner is a multisig with emergency policy authority. The payout receiver can withdraw accumulated proceeds only to itself; it cannot change collection policy or mint.

The web server, IPFS service, marketplace/indexer and promotion database are outside the Solidity review, but their compromise scenarios matter when assessing the voucher and metadata boundaries.

## Security invariants to review

1. Only the exact EIP-712 recipient can redeem.
2. Signatures are bound to chain ID and verifying contract.
3. Token URI, canonical artwork hash, price, nonce, expiry, season and campaign cannot be altered after signing.
4. A nonce cannot be used twice or used after revocation.
5. One canonical artwork hash can map to only one token.
6. Payment must equal the signed price exactly and cannot exceed the owner safety cap.
7. Paused, blocked or—when enabled—unapproved recipients cannot redeem.
8. Maximum supply cannot be exceeded.
9. ERC-721 receiver callbacks cannot re-enter redemption or reuse state.
10. A failed payout preserves the complete contract balance.
11. Only the owner can change signer, policy, payout destination, price cap, collection metadata and royalties.
12. Withdrawal can be initiated only by the owner or current payout receiver and always pays the configured receiver.
13. Frozen collection metadata cannot change.
14. Locked royalties cannot change or be removed and never exceed 10%.
15. Two-step ownership transfer behaves correctly with a multisig recipient.
16. ERC-165, ERC-721, ERC-721Metadata and ERC-2981 behavior remains conformant.

## Checked-in automated evidence

Run from a clean checkout:

```bash
npm ci
npm run contract:compile
npm run contract:test:ci
```

The disposable-chain suite covers valid free and paid redemptions; constructor boundaries; unauthorized administration; wrong payment, recipient, domain, signer, URI and artwork commitments; expiry; nonce replay and revocation; duplicate artwork; block/allow policy; pause; signer rotation; maximum supply; metadata/royalty locks; payout failure; receiver reentrancy; interface detection; and cross-contract replay.

Its seeded 24-case property campaign varies price, nonce, expiry, season, campaign, URI and artwork. It compares the Solidity digest to `ethers.TypedDataEncoder`, then verifies exact mint events, ownership, token URI, provenance mapping and replay rejection. The fixed seed makes failures reproducible. An auditor may request longer or differently seeded campaigns; those are additive and do not replace independent analysis.

## Privileged-role production design

| Role | Required production form | Must not possess |
| --- | --- | --- |
| Owner | reviewed multisig | voucher hot key |
| Voucher signer | dedicated, monitored signing key in a managed secret service | ownership, payout control |
| Payout receiver | treasury/multisig-approved receiver | voucher signing authority unless explicitly reviewed |
| Player | self-custodied recipient wallet | server or owner secrets |
| Backstage operator | named application account with least-privilege role | raw signer or owner key |

Signer rotation, owner recovery, emergency pause and compromised-key response must be rehearsed on testnet before mainnet.

## Parameters that must be approved before testnet deployment

Record approved values and approvers in the release ticket. Blank values prohibit deployment.

| Parameter | Approved value |
| --- | --- |
| Collection name/symbol | `Sketch Arena: The Panic Archive` / `PANIC` |
| Testnet chain/RPC/explorer | **TBD and independently verified** |
| Testnet multisig owner | **TBD** |
| Testnet voucher signer | **TBD** |
| Testnet payout receiver | **TBD** |
| Maximum supply | **TBD** |
| Maximum voucher price | **TBD** |
| Initial collection metadata URI | **TBD** |
| Royalty receiver and basis points | **TBD** |
| Whether/when royalties are locked | **TBD** |
| Voucher maximum lifetime | currently 900 seconds; **approval required** |
| Minimum confirmation depth | currently 1; **approval required** |
| Marketplace-approved collection process | **TBD / evidence required** |

Mainnet addresses and economics require a separate approval after the testnet report. Testnet approval is not mainnet approval.

## Required independent-review output

- severity-ranked findings with exploit prerequisites and affected functions;
- confirmation of compiler/dependency/source hashes and bytecode-size result;
- explicit analysis of EIP-712 domain separation, replay surfaces and signature malleability;
- privilege, multisig, signer-compromise and payout analysis;
- reentrancy, denial-of-service, metadata, royalty and ERC-721 receiver analysis;
- property/fuzz recommendations and results;
- fix verification against a new immutable commit;
- final statement identifying unresolved risks and the exact reviewed commit.

## Deployment gates after review

1. Resolve or formally accept every finding with named approval.
2. Rerun all gates on the reviewed commit.
3. Obtain explicit authorization for a testnet-only deployment.
4. Execute the complete wallet/voucher/IPFS/receipt/marketplace test matrix.
5. Exercise pause, signer rotation and multisig ownership on testnet.
6. Freeze a mainnet parameter sheet and obtain separate explicit deployment approval.

No script in this repository deploys this contract. That boundary is intentional.
