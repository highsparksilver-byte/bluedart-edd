import express from "express";
import crypto from "crypto";
import pg from "pg";

const app = express();

/* ===============================
   RAW BODY (SHOPIFY HMAC)
================================ */
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

/* ===============================
   CORS
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ===============================
   ENV
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

/* ===============================
   HMAC VERIFY
================================ */
function verifyShopify(req) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  if (!hmac || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}

/* ===============================
   SLA CALC
================================ */
function nextCheck(status, firstNdrAt) {
  const now = new Date();

  if (!status) return new Date(now.getTime() + 24 * 3600 * 1000);

  const s = status.toUpperCase();

  if (s.includes("DELIVERED")) return new Date("9999-01-01");

  if (s.includes("OUT FOR DELIVERY"))
    return new Date(now.getTime() + 60 * 60 * 1000);

  if (s.includes("NDR") || s.includes("FAILED")) {
    if (!firstNdrAt)
      return new Date(now.getTime() + 6 * 3600 * 1000);

    const hours = (now - new Date(firstNdrAt)) / 3600000;
    return new Date(
      now.getTime() + (hours < 24 ? 6 : 2) * 3600 * 1000
    );
  }

  return new Date(now.getTime() + 24 * 3600 * 1000);
}

/* ===============================
   OPS CLASSIFIER
================================ */
function classify(status) {
  if (!status) return "clean";
  const s = status.toUpperCase();

  if (s.includes("OUT FOR DELIVERY")) return "out_for_delivery";
  if (s.includes("NDR") || s.includes("FAILED")) return "ndr";

  return "clean";
}

/* ===============================
   CRON TRACK
================================ */
app.post("/_cron/track/run", async (_, res) => {
  const { rows } = await pool.query(
    `SELECT id, awb, last_known_status, first_ndr_at
     FROM shipments
     WHERE next_check_at <= NOW()
     LIMIT 50`
  );

  for (const r of rows) {
    const next = nextCheck(r.last_known_status, r.first_ndr_at);
    await pool.query(
      `UPDATE shipments
       SET next_check_at = $1, updated_at = NOW()
       WHERE id = $2`,
      [next, r.id]
    );
  }

  res.json({ ok: true, processed: rows.length });
});

/* ===============================
   OPS DASHBOARD
================================ */
app.get("/ops/dashboard", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT awb, last_known_status
    FROM shipments
    WHERE delivered_at IS NULL
  `);

  const out = { attention: [], ndr: [], out_for_delivery: [] };

  for (const r of rows) {
    const bucket = classify(r.last_known_status);
    if (bucket !== "clean") out[bucket].push(r);
  }

  res.json(out);
});

/* ===============================
   HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);