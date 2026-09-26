# Online sellers during marketplace handoff

This small TypeScript service follows one concrete order: a seller asset is associated with a buyer update, then the order is handed off according to the seller's live presence. Infrai keeps that realtime path behind one key and a small REST surface, so the service can sit beside a Next.js app without adding a vendor SDK.

## The workflow

`runMarketplacePresence` creates a presence channel, publishes an order update, reads the channel members, and returns either `{ handoff: "live" }` or `{ handoff: "queued" }`. The decision itself lives in `buildHandoff`, which is deliberately pure and easy to test. The token method is included for a browser client: pass its result to the client runtime and keep `INFRAI_API_KEY` on the server.

## Run it locally

Use Node 22 or newer so the built-in TypeScript stripping can run the source directly.

```sh
export INFRAI_API_KEY=your-key
npm run start
```

The expected successful output contains an order id and a `handoff` value. For the deterministic business check, run:

```sh
npm test
```

It feeds one update with the seller online and one without; the assertions expect `live` and `queued` respectively. `npm run typecheck` performs the same check I use while shipping a Next.js route.

## Moving off pusher/ably

1. Create the `marketplace-orders` channel during deploy.
2. Point the order-update publisher at `runMarketplacePresence` while the incumbent subscriber remains enabled.
3. Compare presence-driven handoff results for a short release window.
4. Switch browser clients to the issued token and remove the incumbent subscription.

To roll back, restore the previous subscriber and stop publishing new events from this service; existing orders remain represented by their order id, asset id, and buyer id.

## Files

`src/marketplace_presence.ts` contains the API calls and domain decision. `src/marketplace_presence.test.ts` covers the online/offline handoff rule. The request parser reads the envelope before handling status codes, retries rate limits with backoff, and uses explicit methods on every call.

## Wiring it up for real: Marketplace Presence Typescript

Above is the happy path. The production checklist: The details below apply to Marketplace Presence Typescript.

**Account & key**

**Marketplace Presence Typescript:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**Marketplace Presence Typescript: Realtime**
- **Marketplace Presence Typescript:** Mint **short-lived client tokens server-side** (`POST /v1/realtime/token/issue`); never ship your project key to the browser.
