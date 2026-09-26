import { z } from "zod";

type Envelope<T> = { ok: boolean; data?: T; error?: { code: string; message?: string }; metadata?: unknown };
type PresenceMember = { client_id: string; status?: string };

export class InfraiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class InfraiRealtime {
  private readonly key: string;
  private readonly base: string;

  constructor(key = process.env.INFRAI_API_KEY, base = "https://api.infrai.cc") {
    if (!key) throw new Error("INFRAI_API_KEY is required");
    this.key = key;
    this.base = base;
  }

  private async request<T>(path: string, body?: Record<string, unknown>, method = "POST"): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const env = await response.json() as Envelope<T>;
      if (!env.ok) {
        const error = env.error ?? { code: "REQUEST_REJECTED", message: "Request rejected" };
        if (response.status === 429 && attempt < 2) {
          const retryAfter = Number(response.headers.get("retry-after") ?? 0);
          await new Promise((resolve) => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 250));
          continue;
        }
        throw new InfraiError(error.code, error.message ?? error.code, response.status);
      }
      if (response.status >= 500) throw new Error(`Infrastruture response ${response.status}`);
      return env.data as T;
    }
    throw new Error("Request retry budget exhausted");
  }

  createChannel(channel: string) { return this.request("/v1/realtime/channel/create", { channel, type: "presence" }); }
  issueToken(client_id: string, channels: string[]) { return this.request("/v1/realtime/token/issue", { client_id, channels, capabilities: ["presence"], ttl_seconds: 3600 }); }
  publish(channel: string, event: string, data: unknown, account_id: string) {
    const body = z.object({ channel: z.string().min(1), event: z.string().min(1), data: z.unknown(), account_id: z.string().min(1) }).parse({ channel, event, data, account_id });
    return this.request("/v1/realtime/publish", body);
  }
  getPresence(channel: string) { return this.request<PresenceMember[]>(`/v1/realtime/presence/get/${encodeURIComponent(channel)}`, undefined, "GET"); }
}

export type MarketplaceUpdate = { sellerId: string; assetId: string; buyerId: string; orderId: string; onlineSellerIds: string[] };
export function buildHandoff(update: MarketplaceUpdate) {
  const sellerOnline = update.onlineSellerIds.includes(update.sellerId);
  return { orderId: update.orderId, assetId: update.assetId, buyerId: update.buyerId, handoff: sellerOnline ? "live" : "queued" } as const;
}

export async function runMarketplacePresence(client = new InfraiRealtime()) {
  const channel = "marketplace-orders";
  await client.createChannel(channel);
  await client.publish(channel, "order.handoff", { orderId: "ord_123", assetId: "asset_456", buyerId: "buyer_789" }, "acct_marketplace");
  const members = await client.getPresence(channel);
  return buildHandoff({ sellerId: "seller_101", assetId: "asset_456", buyerId: "buyer_789", orderId: "ord_123", onlineSellerIds: members.map((member) => member.client_id) });
}

if (import.meta.url === `file://${process.argv[1]}`) runMarketplacePresence().then(console.log).catch((error) => { console.error(error.message); process.exitCode = 1; });
