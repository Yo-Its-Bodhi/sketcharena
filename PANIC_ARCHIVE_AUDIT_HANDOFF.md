# Panic Archive independent security-review handoff

Status: deployed and live on Shido mainnet; still awaiting independent Solidity review. See `PANIC_ARCHIVE_MAINNET_EVIDENCE.md` for the exact address, runtime proof, confirmed paid canary and NFTStudio handoff.

This document fixes the intended review boundary for `SketchArenaPanicArchive.sol`. The final auditor package must reference the immutable Git commit produced by the release workflow. Any source change after that commit invalidates the review scope until the auditor accepts the diff.

## Review scope

| Item | Pinned value |
| --- | --- |
| Contract | `contracts/SketchArenaPanicArchive.sol` |
| Current source SHA-256 | `e5ab07960b07fc53cb09ffec57cd4661dc1c42b511441d821d9f64a846740fe1` |
| Adversarial harness | `scripts/test-panic-archive.mjs` |
| Current harness SHA-256 | `4e627098561e4696f29d9f752687a7f74313a6b6ff2c7083cc9969558434c465` |
| Deployment artifact SHA-256 | `71ee58435749945f6a0dcd5762bd1279a55025feb20c4c3730bf35c33dd39d9b` |
| Compiler | Solidity `0.8.26` |
| EVM target | `paris` (Shido-compatible; excludes Shanghai `PUSH0`) |
| Optimizer | enabled, 200 runs |
| OpenZeppelin | `@openzeppelin/contracts@4.9.6` |
| Ethers | `6.15.0` |
| Local chain | Hardhat `3.13.0`, chain ID `31337` |
| Optimized deployed size | 14,381 bytes |
| Intended production chain | Shido EVM, chain ID `9008` |

Recalculate both hashes from the submitted release commit. A mismatch is a review stop, not a warning.

## System purpose and trust boundary

The contract is one permanent ERC-721 collection for Sketch Arena trophies. The game server evaluates private eligibility—first mint free, Mint Credits, discounts, promotions, Battle Pass and achievements—and a dedicated signer produces an EIP-712 voucher. Paid vouchers quote the WSHIDO equivalent of USD $0.99 from guarded off-chain price feeds; the player approves the exact WSHIDO amount and submits the voucher directly from the recipient wallet. Free vouchers transfer no token. Native SHIDO is used only for network gas.

The voucher signer is trusted to authorize price, recipient and public metadata commitments. It must have no ownership or payout authority. The collection owner is a multisig with emergency policy authority. Paid redemptions transfer WSHIDO directly from the recipient to the current payout receiver, so the collection should not custody sale proceeds.

The web server, IPFS service, marketplace/indexer and promotion database are outside the Solidity review, but their compromise scenarios matter when assessing the voucher and metadata boundaries.

## Security invariants to review

1. Only the exact EIP-712 recipient can redeem.
2. Signatures are bound to chain ID and verifying contract.
3. Token URI, canonical artwork hash, price, nonce, expiry, season and campaign cannot be altered after signing.
4. A nonce cannot be used twice or used after revocation.
5. One canonical artwork hash can map to only one token.
6. Payment uses the immutable reviewed WSHIDO token, transfers the signed amount directly to the payout receiver and cannot exceed the owner safety cap.
7. Paused, blocked or—when enabled—unapproved recipients cannot redeem.
8. Maximum supply cannot be exceeded.
9. ERC-721 receiver callbacks cannot re-enter redemption or reuse state.
10. A failed or unapproved WSHIDO transfer reverts the entire redemption, including nonce and provenance state.
11. Only the owner can change signer, policy, payout destination, price cap and collection metadata.
12. The contract does not accept native SHIDO through redemption and does not retain successful WSHIDO payments.
13. Frozen collection metadata cannot change.
14. Every token permanently reports its original minting wallet as its ERC-2981 royalty receiver at the immutable collection artist rate, never exceeding 10%.
15. Two-step ownership transfer behaves correctly with a multisig recipient.
16. ERC-165, ERC-721, ERC-721Metadata and ERC-2981 behavior remains conformant.

## Checked-in automated evidence

Run from a clean checkout:

```bash
npm ci
npm run contract:compile
npm run contract:test:ci
```

The disposable-chain suite covers valid free and paid WSHIDO redemptions; token and constructor boundaries; missing allowance; unauthorized administration; wrong recipient, domain, signer, URI and artwork commitments; expiry; nonce replay and revocation; duplicate artwork; block/allow policy; pause; signer rotation; maximum supply; frozen metadata; per-token original-minter royalties; direct payout accounting; receiver reentrancy; interface detection; and cross-contract replay.

Its seeded 24-case property campaign varies price, nonce, expiry, season, campaign, URI and artwork. It compares the Solidity digest to `ethers.TypedDataEncoder`, then verifies exact mint events, ownership, token URI, provenance mapping and replay rejection. The fixed seed makes failures reproducible. An auditor may request longer or differently seeded campaigns; those are additive and do not replace independent analysis.

## Privileged-role production design

| Role | Required production form | Must not possess |
| --- | --- | --- |
| Owner | approved self-custodied admin wallet; migrate to a reviewed multisig when available | voucher hot key |
| Voucher signer | dedicated, monitored signing key in a managed secret service | ownership, payout control |
| Payout receiver | treasury/multisig-approved receiver | voucher signing authority unless explicitly reviewed |
| Player | self-custodied recipient wallet | server or owner secrets |
| Backstage operator | named application account with least-privilege role | raw signer or owner key |

Signer rotation, owner recovery, emergency pause and compromised-key response were exercised on the local ephemeral chain. The product owner explicitly selected a paused mainnet canary because no usable Shido testnet is available.

## Approved deployment parameters

Record approved values and approvers in the release ticket. Blank values prohibit deployment.

| Parameter | Approved value |
| --- | --- |
| Collection name/symbol | `Sketch Arena: The Panic Archive` / `PANIC` |
| Testnet chain/RPC/explorer | no usable Shido testnet selected; local ephemeral chain plus paused mainnet canary approved as the proposed path |
| Production owner/admin | `0xA9E8a36E648E2C5DDc53D9942b88a158B7789E4e` |
| Production voucher signer | `0x44A5920654B1D6DFDC92E201514F1389e6dAc3e7` (private key restricted to the Sketch Arena service host) |
| Production payout receiver | `0xAe0CEb4Bc23Dfdd552eaE2865481B191C3b28da1` |
| Immutable WSHIDO payment token | `0x8cbaffd9b658997e7bf87e98febf6ea6917166f7` (live name/symbol/decimals verified as Wrapped Shido / WSHIDO / 18) |
| Maximum supply | effectively unlimited permanent collection; seasons remain metadata divisions |
| Maximum voucher price | `type(uint256).max` at deployment: the cap is intentionally non-economic because a fixed WSHIDO amount cannot represent a stable USD ceiling. Exact user approval plus the signed short-lived price remains the spend boundary; the owner can install an emergency token cap later. |
| Standard mint policy | USD `$0.99` converted to WSHIDO in each short-lived voucher; primary/fallback quotes must stay within 10% or paid minting fails closed |
| Initial collection metadata URI | `https://sketch.bodhix.io/api/archive/metadata` (owner-updatable until deliberately frozen) |
| Artist royalty | 500 bps (5%) per token, permanently payable to that token's original minting wallet—not the Sketch Arena owner or treasury |
| Voucher maximum lifetime | 900 seconds; approved by product owner |
| Minimum confirmation depth | 3 confirmations; approved by product owner |
| Marketplace-approved collection process | Approved by NFTStudio Marketplace V2 at `0x19ee7a8D5Ee19c38d1754290b483BE6f4483e9d6`; indexed slug and public URL are recorded in `PANIC_ARCHIVE_MAINNET_EVIDENCE.md` |

The exact Paris-targeted creation transaction was successfully estimated against Shido mainnet on 2026-08-17 at 3,469,589 gas. Gas price and final wallet cost remain live network values and must be reviewed in the wallet at signing time.

## Required independent-review output

- severity-ranked findings with exploit prerequisites and affected functions;
- confirmation of compiler/dependency/source hashes and bytecode-size result;
- explicit analysis of EIP-712 domain separation, replay surfaces and signature malleability;
- privilege, multisig, signer-compromise and payout analysis;
- reentrancy, denial-of-service, metadata, royalty and ERC-721 receiver analysis;
- property/fuzz recommendations and results;
- fix verification against a new immutable commit;
- final statement identifying unresolved risks and the exact reviewed commit.

## Deployment gates and current evidence

1. Resolve or formally accept every finding with named approval.
2. Rerun all gates on the reviewed commit.
3. Because no working Shido testnet is being used, obtain explicit authorization for the elevated-risk mainnet path.
4. **Complete:** mainnet was deployed paused and the runtime, constructor parameters, roles and signer were independently read back.
5. **Partially complete:** one controlled **paid** canary was confirmed and its receipt, event, token URI and original-artist royalty were verified. This is not evidence of the free-mint entitlement path.
6. **Complete:** public minting is open and the collection is approved and indexed by NFTStudio. Pause and signer-rotation readiness must remain part of recurring operations.

Backstage can prepare the exact checked-in artifact and constructor arguments for the approved owner wallet. It cannot sign, cannot accept a private key, refuses a second deployment after an address is configured, and verifies a successful receipt has contract code before displaying an address. The constructor starts paused; a separate owner transaction is required to unpause after independent verification.

Before opening a pristine deployment, `npm run contract:verify:mainnet -- 0xCollectionAddress` checks the paused/no-mints-yet state. For a live deployment, use `--state live-canary` with the exact canary transaction, IPFS token URI and WSHIDO base-unit price; the command then verifies the receipt, mint event, current ownership, metadata and original-artist royalty as well as every common runtime, role and policy invariant.
