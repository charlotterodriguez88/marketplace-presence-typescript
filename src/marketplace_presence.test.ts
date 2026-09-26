import assert from "node:assert/strict";
import { buildHandoff } from "./marketplace_presence.ts";

const live = buildHandoff({ sellerId: "seller_1", assetId: "asset_1", buyerId: "buyer_1", orderId: "order_1", onlineSellerIds: ["seller_1"] });
const queued = buildHandoff({ sellerId: "seller_1", assetId: "asset_1", buyerId: "buyer_1", orderId: "order_1", onlineSellerIds: [] });
assert.equal(live.handoff, "live");
assert.equal(queued.handoff, "queued");
console.log("handoff decision test passed");
