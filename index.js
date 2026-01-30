import express from "express";
import crypto from "crypto";
import pg from "pg";

const app = express();

/* ===============================
   🔐 RAW BODY (REQUIRED FOR HMAC)
================================ */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

/* ===============================
   🌍 CORS
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ===============================
   🔑 ENV
================================ */
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
if (!SHOPIFY_WEBHOOK_SECRET) {
  console.error("❌ SHOPIFY_WEBHOOK_SECRET missing");
}

/* ===============================
   🗄️ DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🔐 HMAC VERIFY
================================ */
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader)
  );
}

/* ===============================
   📦 WEBHOOK: ORDER PAID
================================ */
app.post("/webhooks/orders-paid", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      console.warn("❌ Invalid webhook signature");
      return res.status(401).json({ error: "invalid_signature" });
    }

    const order = req.body;
    console.log("✅ Order paid webhook:", order.name);

    // IMPORTANT:
    // We DO NOT insert shipments here.
    // Shopify remains the source of truth.
    // This webhook is only for OPS awareness / future linking.

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "webhook_failed" });
  }
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);