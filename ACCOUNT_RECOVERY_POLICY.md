# Sketch Arena account recovery policy

Effective for the Season 0 beta.

Sketch Arena accounts do not use passwords and are not recovered through a wallet address or display name. A player controls an account through one of two private proofs:

1. A registered passkey, such as Face ID, Touch ID, Windows Hello, Android screen lock or a synced password-manager passkey.
2. The account's `SKETCH-VAULT-V1-…` emergency recovery key.

## What players should do

- Add at least one passkey from **My Account → Account Authority**.
- Add a second passkey on another trusted device or in a trusted passkey manager when possible.
- Download or copy the emergency recovery key and store it somewhere private and offline.
- Never send the recovery key in chat, email, a support ticket or a screenshot. Sketch Arena staff will never ask for it.
- Use **Signed-in devices** to remove a device that is lost, sold or no longer trusted.

## Moving to or recovering on another device

- Choose **Sign in with a passkey** when a registered passkey is available.
- Otherwise choose **Restore with a recovery key** and enter the complete emergency key.
- Restoring opens the same durable player account, Vault, progression, rewards, Battle Pass state and wallet binding. It does not copy or merge a different local account.
- Restoring signs the browser out of its current account first. It does not delete that other account.

## What support can and cannot do

Support can explain the recovery flow, help identify a revoked or stale device session and investigate service errors without asking for private credentials.

Support cannot:

- reveal or regenerate a player's recovery key;
- bypass a passkey or its device verification;
- recover an account from a display name, wallet address, NFT ownership or screenshot;
- merge two player accounts or move achievements, rewards, Vault drafts or mint credits between them;
- reverse a confirmed blockchain transfer or delete a minted NFT from Shido/IPFS.

If every registered passkey is unavailable and the emergency recovery key has been lost, the account cannot be recovered. This is deliberate: no staff member or database leak should be able to impersonate a player.

## Security and privacy behavior

- The server stores hashes of recovery credentials, not the recovery key itself.
- Device sessions are expiring, individually revocable and stored in secure HttpOnly cookies.
- Passkey challenges are short-lived and single-use, require user verification and are bound to `sketch.bodhix.io`.
- Wallet ownership is verified separately and is never a substitute for player-account authority.
- Signing out removes the current browser's local Sketch Arena identity. Players without a passkey should back up the recovery key before signing out.

Suspected compromise should be handled by signing in from a trusted device, revoking unfamiliar device sessions, registering a new passkey and preserving the emergency recovery key. Production support must never request or accept that key.
