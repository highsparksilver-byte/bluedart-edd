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
   💰 WEBHOOK: ORDER PAID
================================ */
app.post("/webhooks/orders-paid", (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.warn("❌ Invalid ORDER PAID webhook signature");
    return res.status(401).end();
  }

  const order = req.body;
  console.log("💰 ORDER PAID");
  console.log("Order:", order.name);
  console.log("Payment:", order.financial_status);

  res.json({ ok: true });
});

/* ===============================
   📦 WEBHOOK: FULFILLMENT CREATED
================================ */
app.post("/webhooks/fulfillment-created", (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.warn("❌ Invalid FULFILLMENT webhook signature");
    return res.status(401).end();
  }

  const f = req.body;

  console.log("📦 FULFILLMENT CREATED");
  console.log("Order ID:", f.order_id);
  console.log("Fulfillment ID:", f.id);
  console.log("Courier:", f.tracking_company);
  console.log("AWB:", f.tracking_number);

  res.json({ ok: true });
});

/* ===============================
   ❌ WEBHOOK: ORDER CANCELLED
================================ */
app.post("/webhooks/orders-cancelled", (req, res) => {
  if (!verifyShopifyWebhook(req)) {
    console.warn("❌ Invalid CANCEL webhook signature");
    return res.status(401).end();
  }

  const order = req.body;

  console.log("❌ ORDER CANCELLED");
  console.log("Order:", order.name);
  console.log("Reason:", order.cancel_reason);

  res.json({ ok: true });
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);