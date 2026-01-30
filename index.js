import express from "express";
import axios from "axios";
import xml2js from "xml2js";
import pg from "pg";
import crypto from "crypto";

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
  CLIENT_ID,
  CLIENT_SECRET,
  LOGIN_ID,
  BD_LICENCE_KEY_TRACK,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_SCOPES,
  SHOPIFY_API_VERSION,
  APP_URL,
} = process.env;

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   📦 CUSTOMER TRACKING — PHASE 7.2
================================================= */
/*
Rules:
1️⃣ Customer can search via phone OR email OR order_id
2️⃣ If ANY active order exists → show ONLY active orders
3️⃣ If NO active orders → show ONLY latest delivered order
4️⃣ If multiple active → return list
*/

app.post("/track/customer", async (req, res) => {
  try {
    const { phone, email, order_id } = req.body;

    if (!phone && !email && !order_id) {
      return res.status(400).json({
        error: "Provide phone OR email OR order_id",
      });
    }

    const conditions = [];
    const values = [];

    if (phone) {
      values.push(phone);
      conditions.push(`customer_mobile = $${values.length}`);
    }

    if (email) {
      values.push(email);
      conditions.push(`customer_email = $${values.length}`);
    }

    if (order_id) {
      values.push(order_id);
      conditions.push(`shopify_order_id = $${values.length}`);
    }

    const whereClause = conditions.join(" OR ");

    /* ---------- 1️⃣ FETCH ALL MATCHING ORDERS ---------- */
    const { rows } = await pool.query(
      `
      SELECT *
      FROM shipments
      WHERE ${whereClause}
      ORDER BY created_at DESC
      `,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "No orders found" });
    }

    /* ---------- 2️⃣ SPLIT ACTIVE VS DELIVERED ---------- */
    const activeOrders = rows.filter(
      (o) => o.delivery_confirmed === false
    );

    // 🟢 CASE A: ANY ACTIVE → SHOW ONLY ACTIVE
    if (activeOrders.length > 0) {
      return res.json({
        mode: "ACTIVE_ONLY",
        count: activeOrders.length,
        orders: activeOrders.map(formatOrder),
      });
    }

    // 🔵 CASE B: ALL DELIVERED → SHOW LATEST ONE ONLY
    const latestDelivered = rows[0];

    return res.json({
      mode: "LATEST_DELIVERED",
      count: 1,
      orders: [formatOrder(latestDelivered)],
    });
  } catch (err) {
    console.error("❌ Customer tracking failed:", err.message);
    res.status(500).json({ error: "Tracking failed" });
  }
});

/* =================================================
   🧩 FORMATTER
================================================= */
function formatOrder(row) {
  return {
    order_id: row.shopify_order_id,
    order_name: row.shopify_order_name,
    awb: row.awb,
    courier: row.courier,
    status: row.last_known_status,
    delivered: row.delivery_confirmed,
    delivered_at: row.delivered_at,
    last_checked_at: row.last_checked_at,
  };
}

/* =================================================
   🔑 SHOPIFY OAUTH (ALREADY INSTALLED)
================================================= */
app.get("/auth/shopify", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop");

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${APP_URL}/auth/shopify/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_CLIENT_ID}` +
    `&scope=${SHOPIFY_SCOPES}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  res.redirect(installUrl);
});

app.get("/auth/shopify/callback", async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;
    if (!shop || !code || !hmac) return res.status(400).send("Missing params");

    const query = { ...req.query };
    delete query.hmac;
    delete query.signature;

    const message = new URLSearchParams(query).toString();
    const generatedHmac = crypto
      .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
      .update(message)
      .digest("hex");

    if (generatedHmac !== hmac) {
      return res.status(401).send("HMAC validation failed");
    }

    await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      code,
    });

    res.send("✅ App Installed Successfully");
  } catch (err) {
    res.status(500).send("OAuth failed");
  }
});

/* =================================================
   🚀 START SERVER
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);
