import express from "express";
import axios from "axios";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(express.json());

/* =================================================
   🔑 ENV
================================================= */
const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION,
  SHOPIFY_SCOPES,
  APP_URL
} = process.env;

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   🔐 SHOPIFY AUTH START
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

/* =================================================
   🔐 SHOPIFY CALLBACK (SAVE TOKEN)
================================================= */
app.get("/auth/shopify/callback", async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;

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

    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      }
    );

    const { access_token } = tokenRes.data;

    // ✅ SAVE TOKEN
    await pool.query(
      `
      INSERT INTO shopify_shops (shop_domain, access_token)
      VALUES ($1, $2)
      ON CONFLICT (shop_domain)
      DO UPDATE SET access_token = EXCLUDED.access_token
      `,
      [shop, access_token]
    );

    res.send("✅ App installed successfully. You may close this tab.");

  } catch (err) {
    console.error("OAuth failed", err.message);
    res.status(500).send("OAuth failed");
  }
});

/* =================================================
   🕒 CRON — SHOPIFY SYNC (FIXED)
================================================= */
app.post("/_cron/shopify/sync-orders", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT shop_domain, access_token FROM shopify_shops LIMIT 1`
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: "No shop installed" });
    }

    const { shop_domain, access_token } = rows[0];

    const url = `https://${shop_domain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=5`;

    const response = await axios.get(url, {
      headers: {
        "X-Shopify-Access-Token": access_token
      }
    });

    res.json({
      ok: true,
      orders_fetched: response.data.orders.length
    });

  } catch (err) {
    console.error("❌ Shopify sync failed", err.response?.data || err.message);
    res.status(500).json({ ok: false });
  }
});

/* =================================================
   🚀 START
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on port", PORT)
);