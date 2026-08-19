# BodhiX app adapter

Server-side adapter for joining an existing BodhiX app to the shared account, XP and reward authority.

- Exchange PKCE codes only in an app's server callback.
- Store the returned app session only in the app's server-side session store.
- Never put an app session in a browser cookie, URL, local storage or client bundle.
- Award XP only from authoritative server outcomes with a stable idempotency key.
- Reserve consumable rewards before delivery; the Mothership operator fulfils or rejects them with a receipt.
- An app remains marked `private` in the Mothership until its adapter and user flow are tested in production.

The package intentionally contains no Season 1 pricing or public premium copy.
