import express from "express";
import crypto from "crypto";
import axios from "axios";
import pg from "pg";

const { Pool } = pg;

/* =================================================
   🗄️ DATABASE (NEON)
================================================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =================================================
   🚀 APP INIT
================================================= */
const app = express();
app.use(express.json());

/* =================================================
   🔑 ENV
================================================= */
const {
  PORT = 3000,
  APP_URL,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_SCOPES,
  SHOPIFY_API_VERSION
} = process.env;

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/", (_, res) => {
  res.send("Ops Logistics Sync running ✅");
});

/* =================================================
   🔐 PHASE 6 — SHOPIFY AUTH START
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

  console.log("➡️ Redirecting to Shopify:", installUrl);
  res.redirect(installUrl);
});

/* =================================================
   🔐 PHASE 6 — SHOPIFY CALLBACK
================================================= */
app.get("/auth/shopify/callback", async (req, res) => {
  try {
    const { shop, code, hmac } = req.query;
    if (!shop || !code || !hmac) {
      return res.status(400).send("Missing OAuth params");
    }

    /* ---- HMAC VALIDATION ---- */
    const query = { ...req.query };
    delete query.hmac;
    delete query.signature;

    const message = new URLSearchParams(query).toString();

    const generatedHmac = crypto
      .createHmac("sha256", SHOPIFY_CLIENT_SECRET)
      .update(message)
      .digest("hex");

    if (generatedHmac !== hmac) {
      console.error("❌ HMAC failed");
      return res.status(401).send("Invalid HMAC");
    }

    /* ---- TOKEN EXCHANGE ---- */
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      }
    );

    const { access_token } = tokenRes.data;

    /* ---- SAVE SHOP TOKEN ---- */
    await pool.query(
      `
      INSERT INTO shopify_shops (shop, access_token)
      VALUES ($1, $2)
      ON CONFLICT (shop)
      DO UPDATE SET access_token = EXCLUDED.access_token
      `,
      [shop, access_token]
    );

    console.log("✅ Shopify connected:", shop);

    res.send(`
      <h2>✅ App Installed</h2>
      <p>${shop}</p>
      <p>You can close this window.</p>
    `);
  } catch (err) {
    console.error("❌ OAuth error:", err.message);
    res.status(500).send("OAuth failed");
  }
});

/* =================================================
   🔄 PHASE 7.1 — SHOPIFY → SHIPMENTS SYNC
================================================= */
app.post("/_cron/shopify-sync", async (_, res) => {
  try {
    const { rows: shops } = await pool.query(
      `SELECT shop, access_token FROM shopify_shops`
    );

    let total = 0;

    for (const { shop, access_token } of shops) {
      const ordersRes = await axios.get(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=50`,
        { headers: { "X-Shopify-Access-Token": access_token } }
      );

      for (const order of ordersRes.data.orders) {
        const customer = order.customer || {};
        const phone = customer.phone || order.phone || null;
        const email = customer.email || null;

        for (const f of order.fulfillments || []) {
          if (!f.tracking_number) continue;

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
              delivery_confirmed,
              created_at,
              updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,false,NOW(),NOW())
            ON CONFLICT (awb) DO UPDATE SET
              customer_mobile = EXCLUDED.customer_mobile,
              customer_email = EXCLUDED.customer_email,
              updated_at = NOW()
            `,
            [
              order.id.toString(),
              order.name,
              f.id.toString(),
              f.tracking_number,
              (f.tracking_company || "").toLowerCase(),
              phone,
              email
            ]
          );

          total++;
        }
      }
    }

    console.log("🔄 Shopify sync complete:", total);
    res.json({ ok: true, synced: total });
  } catch (err) {
    console.error("❌ Shopify sync failed:", err.message);
    res.status(500).json({ ok: false });
  }
});

/* =================================================
   🧠 KEEP ALIVE (RENDER)
================================================= */
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios
      .get(`${process.env.RENDER_EXTERNAL_URL}/`)
      .catch(() => {});
  }, 10 * 60 * 1000);
}

/* =================================================
   🚀 START SERVER
================================================= */
app.listen(PORT, () => {
  console.log("🚀 Ops Logistics running on port", PORT);
});
