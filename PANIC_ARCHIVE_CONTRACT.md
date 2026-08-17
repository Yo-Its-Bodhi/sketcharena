# Panic Archive voucher contract

Status: compiled implementation draft; **not deployed and not approved for production funds**.

The fixed independent-review scope, threat model, role design, parameter sheet and required auditor output are in `PANIC_ARCHIVE_AUDIT_HANDOFF.md`.

Current automated evidence:

- optimized Solidity compilation succeeds and produces 14,731 bytes of deployed code;
- the ephemeral-chain harness successfully deploys and verifies free and paid EIP-712 redemption;
- it rejects incorrect payment, replay, duplicate artwork, revoked vouchers, blocked recipients, unapproved recipients, obsolete signers and paused minting;
- it rejects recipient, token URI, artwork hash, deadline, price-cap and EIP-712 domain tampering;
- it verifies allowlist approval, signer rotation, maximum supply, ERC-165/ERC-721/ERC-721Metadata/ERC-2981 interfaces, receiver-callback reentrancy protection, payout rejection with balance preservation, immutable collection metadata, locked royalties, payout withdrawal, ownership, token URI and artwork-to-token provenance;
- it checks that mutating every signed voucher field changes the on-chain EIP-712 digest.
- a seeded 24-case property run proves ethers/Solidity digest agreement across randomized voucher fields, exact free/paid redemption events, nonce replay rejection, ownership, token URI and artwork provenance invariants;
- a voucher signed for the primary collection is rejected by a second collection, proving the verifying-contract domain prevents cross-collection replay.

The reproducible seeded property suite is now part of CI. Independent specialist review, any additional auditor-requested fuzz campaigns and a Shido testnet rehearsal remain mandatory before deployment.

`contracts/SketchArenaPanicArchive.sol` is the dedicated one-time collection contract for **Sketch Arena: The Panic Archive**. Seasons, including Season 0 **The First Mess**, are recorded per token rather than represented by separate collection deployments.

## What a voucher commits to

Every EIP-712 signature binds all of the following:

- exact recipient wallet;
- immutable token-URI hash;
- unique canonical artwork hash;
- exact native-token price, including zero for a free mint;
- globally unique one-use nonce;
- expiry timestamp;
- season ID;
- campaign ID.

The redeeming wallet must be the named recipient. A voucher cannot be redirected, have its price changed, use different metadata, or mint the same artwork twice. Used and revoked nonces cannot be replayed.

Promo codes, discounts, giveaways, achievements, Battle Pass rewards and Mint Credits remain private server-side eligibility inputs. The backend validates them and signs the final voucher; raw promotional codes are never published on-chain.

## Operator controls

- rotate the mint signer immediately;
- revoke a voucher nonce before redemption;
- block or explicitly approve recipient wallets;
- enable an allowlist-only emergency posture;
- prepare recipient allow/block and global allowlist-policy changes in Backstage, while requiring the collection owner wallet to sign and submit every change;
- pause/unpause all redemptions;
- set a maximum voucher price as a signing-error circuit breaker;
- rotate the payout receiver;
- update then permanently freeze collection metadata;
- configure royalties up to 10%, remove them, or permanently lock the current choice;
- withdraw only to the configured payout receiver.

Production ownership should be transferred to a multisig. The voucher signer should be a separate hot signing key with no ownership or withdrawal authority.

## Required tests before deployment

Compilation is necessary but not a security review. Deployment remains gated on automated chain tests covering:

1. valid paid and free redemption;
2. wrong recipient, signer, chain/domain, URI, artwork hash, price and expired deadline;
3. replayed, revoked and cross-campaign nonces;
4. duplicate artwork under a new voucher;
5. blacklist and allowlist transitions;
6. pause, signer rotation and maximum-supply boundaries;
7. ERC-721 receiver reentrancy attempts;
8. payout failure and authorization;
9. ERC-165/ERC-721/ERC-2981 interface behavior;
10. royalty and collection-metadata locks;
11. extend the checked-in seeded property run with any independent auditor-requested invariants or higher-volume campaigns;
12. independent contract review and a Shido testnet dry run.

No deployment script is intentionally included yet. Adding or running one requires explicit approval.
