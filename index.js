import express from "express";
import crypto from "crypto";
import pg from "pg";

const app = express();

/* =========================================================
   🔐 RAW BODY (required for Shopify HMAC verification)
========================================================= */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

/* =========================================================
   🌍 CORS
========================================================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* =========================================================
   🔑 ENV
========================================================= */
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
if (!SHOPIFY_WEBHOOK_SECRET) {
  console.error("❌ SHOPIFY_WEBHOOK_SECRET missing");
}

/* =========================================================
   🗄️ DB
========================================================= */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================================================
   🔐 HMAC VERIFY
========================================================= */
function verifyShopifyWebhook(req) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!hmac || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmac)
  );
}

/* =========================================================
   🧠 ORDER TYPE LOGIC
========================================================= */
function detectOrderType(order) {
  const tags = (order.tags || "").toLowerCase();

  if (tags.includes("ppcod")) return "PPCOD";
  if (order.financial_status === "paid") return "PREPAID";
  return "COD";
}

/* =========================================================
   📦 WEBHOOK: ORDER PAID
========================================================= */
app.post("/webhooks/orders-paid", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const o = req.body;

    const orderType = detectOrderType(o);

    await pool.query(
      `
      INSERT INTO orders_ops (
        shopify_order_id,
        shopify_order_name,
        shop_domain,
        financial_status,
        fulfillment_status,
        is_paid,
        is_cancelled,
        order_type,
        tags,
        customer_email,
        customer_phone,
        currency,
        order_total,
        total_tax,
        total_discounts
      )
      VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (shopify_order_id)
      DO UPDATE SET
        financial_status = EXCLUDED.financial_status,
        is_paid = EXCLUDED.is_paid,
        updated_at = NOW()
      `,
      [
        o.id.toString(),
        o.name,
        o.shop_domain || null,
        o.financial_status,
        o.fulfillment_status,
        o.financial_status === "paid",
        orderType,
        o.tags ? o.tags.split(",") : [],
        o.email || null,
        o.phone || null,
        o.currency || "INR",
        Number(o.total_price || 0),
        Number(o.total_tax || 0),
        Number(o.total_discounts || 0)
      ]
    );

    console.log("✅ orders-paid:", o.name);
    res.json({ ok: true });

  } catch (err) {
    console.error("orders-paid error:", err);
    res.status(500).json({ error: "orders-paid-failed" });
  }
});

/* =========================================================
   📦 WEBHOOK: FULFILLMENT CREATED
========================================================= */
app.post("/webhooks/fulfillment-created", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const f = req.body;
    const orderId = f.order_id?.toString();

    await pool.query(
      `
      UPDATE orders_ops
      SET fulfillment_status = 'fulfilled',
          fulfilled_at = NOW(),
          updated_at = NOW()
      WHERE shopify_order_id = $1
      `,
      [orderId]
    );

    console.log("📦 fulfillment:", orderId);
    res.json({ ok: true });

  } catch (err) {
    console.error("fulfillment error:", err);
    res.status(500).json({ error: "fulfillment-failed" });
  }
});

/* =========================================================
   ❌ WEBHOOK: ORDER CANCELLED
========================================================= */
app.post("/webhooks/orders-cancelled", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.status(401).json({ error: "invalid_signature" });
    }

    const o = req.body;

    await pool.query(
      `
      UPDATE orders_ops
      SET is_cancelled = true,
          fulfillment_status = 'cancelled',
          cancelled_at = NOW(),
          updated_at = NOW()
      WHERE shopify_order_id = $1
      `,
      [o.id.toString()]
    );

    console.log("❌ cancelled:", o.name);
    res.json({ ok: true });

  } catch (err) {
    console.error("cancel error:", err);
    res.status(500).json({ error: "cancel-failed" });
  }
});

/* =========================================================
   📊 OPS DASHBOARD – ORDERS
========================================================= */
app.get("/ops/orders", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT *
    FROM orders_ops
    ORDER BY created_at DESC
  `);

  const prepaid_fast_ship = rows.filter(
    r => r.order_type === "PREPAID" && !r.is_cancelled && r.fulfillment_status !== "fulfilled"
  );

  const ppcod_to_confirm = rows.filter(
    r => r.order_type === "PPCOD" && !r.is_cancelled && r.fulfillment_status !== "fulfilled"
  );

  const cod_to_call = rows.filter(
    r => r.order_type === "COD" && !r.is_cancelled && r.fulfillment_status !== "fulfilled"
  );

  const cancelled = rows.filter(r => r.is_cancelled);

  res.json({
    prepaid_fast_ship,
    ppcod_to_confirm,
    cod_to_call,
    cancelled
  });
});

/* =========================================================
   ❤️ HEALTH
========================================================= */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);