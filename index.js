import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

/* =================================================
   🗄️ DATABASE (NEON)
================================================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =================================================
   🚀 APP INIT
================================================= */
const app = express();
app.use(express.json());

/* =================================================
   🌍 CORS
================================================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

/* =================================================
   🔑 ENV
================================================= */
const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION,
  APP_URL,
  SHOPIFY_SHOP,
  SHOPIFY_ACCESS_TOKEN,
} = process.env;

console.log("🚀 Ops Logistics starting…");

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   🛍️ SHOPIFY CLIENT
================================================= */
const shopify = axios.create({
  baseURL: `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}`,
  headers: {
    "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
    "Content-Type": "application/json",
  },
});

/* =================================================
   📅 CONSTANTS
================================================= */
const SYNC_START_DATE = "2026-01-01T00:00:00Z";

/* =================================================
   🔁 PHASE 8.1 — SHOPIFY ORDER SYNC
================================================= */
app.post("/_cron/shopify/sync-orders", async (req, res) => {
  console.log("🛍️ Shopify sync started");

  let pageInfo = null;
  let inserted = 0;
  let scanned = 0;

  try {
    while (true) {
      const params = {
        limit: 50,
        status: "any",
        created_at_min: SYNC_START_DATE,
      };

      if (pageInfo) params.page_info = pageInfo;

      const response = await shopify.get("/orders.json", { params });
      const orders = response.data.orders || [];

      if (!orders.length) break;

      for (const order of orders) {
        scanned++;

        const phone =
          order.phone ||
          order.shipping_address?.phone ||
          null;

        for (const f of order.fulfillments || []) {
          if (!f.tracking_number) continue;

          const awb = f.tracking_number.trim();

          await pool.query(
            `
            INSERT INTO shipments (
              shopify_order_id,
              shopify_order_name,
              fulfillment_id,
              awb,
              courier,
              customer_mobile,
              customer_email,
              last_known_status,
              delivery_confirmed,
              next_check_at,
              shop_domain,
              created_at,
              updated_at
            )
            VALUES (
              $1,$2,$3,$4,$5,$6,$7,$8,false,NOW(),$9,NOW(),NOW()
            )
            ON CONFLICT (awb)
            DO UPDATE SET
              last_known_status = EXCLUDED.last_known_status,
              updated_at = NOW()
          `,
            [
              order.id.toString(),
              order.name,
              f.id.toString(),
              awb,
              (f.tracking_company || "bluedart").toLowerCase(),
              phone,
              order.email,
              f.status || "In Transit",
              SHOPIFY_SHOP,
            ]
          );

          inserted++;
        }
      }

      const link = response.headers.link;
      if (!link || !link.includes("rel=\"next\"")) break;

      const match = link.match(/page_info=([^&>]+)/);
      if (!match) break;

      pageInfo = match[1];
    }

    console.log("✅ Shopify sync complete");
    res.json({
      ok: true,
      scanned_orders: scanned,
      shipments_upserted: inserted,
    });

  } catch (err) {
    console.error("❌ Shopify sync failed");
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🧠 KEEP ALIVE (RENDER)
================================================= */
const SELF_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/health`
  : null;

if (SELF_URL) {
  setInterval(() => {
    axios.get(SELF_URL).catch(() => {});
  }, 10 * 60 * 1000);
}

/* =================================================
   🚀 START
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);