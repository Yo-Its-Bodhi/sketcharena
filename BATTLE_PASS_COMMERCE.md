# Premium Panic Pass commerce boundary

The Premium Panic Pass is a normal Sketch Arena account entitlement. It is not an NFT and must not require a wallet. Current source supports audited staff/giveaway grants, retroactive premium-tier fulfilment, catalogued owned items and equipped avatar/brush utility. Public paid checkout stays locked until a USD payment provider and price are explicitly approved.

## Non-negotiable sale flow

1. The authenticated server creates an order containing a random order ID, player UUID, immutable `season-0` product/version, exact USD cents, currency, provider and `pending` status.
2. The server creates the provider checkout session. The browser receives only the provider-hosted checkout URL/public session reference.
3. Returning to a success URL never grants the pass. It only displays `confirming payment` and polls the order.
4. A signature-verified provider webhook is the sole payment authority. Its event ID and checkout/payment ID are unique and idempotent.
5. The webhook transaction changes the order to `paid` and grants one `battle-pass` reward with `idempotencyKey=pass-order:<orderId>` and `actor=system:checkout:<provider>`.
6. Duplicate or reordered webhooks return success without duplicating rewards. Mismatched amount, currency, product metadata or player ID fail closed and enter Backstage review.
7. Backstage shows pending/paid/failed/refunded/disputed counts, exact order/provider references, fulfilment state and named manual actions. Staff cannot mark an unpaid order paid.
8. Refund policy must be approved before sales. Recommended: retain already-claimed gameplay cosmetics and achievements, disable future premium-tier claims for a refunded/disputed pass, and record the adjustment instead of deleting history.

## Required implementation evidence

- Provider selected and official SDK/API pinned.
- Price and tax/VAT treatment approved in writing.
- Webhook signing secret stored only in the production secret manager.
- Raw-body webhook signature verification covered by fixture tests.
- Database uniqueness on provider event, checkout, payment and one season pass per player.
- Successful, cancelled, expired, duplicated, delayed, wrong-amount, refund and dispute fixtures.
- Test-mode checkout from two browsers; second device sees the same account entitlement.
- Backstage reconciliation and export.
- Privacy/terms/refund copy and support runbook published.

No public `BUY` button should be enabled before every item above is proven. Staff, achievement, giveaway and thank-you pass grants can continue through the existing idempotent Backstage reward path.
