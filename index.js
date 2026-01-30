import express from "express";
import pg from "pg";

const { Pool } = pg;

/* ================================
   DATABASE
================================ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================================
   APP INIT
================================ */
const app = express();
app.use(express.json());

/* ================================
   CORS
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ================================
   RATE LIMITERS (MEMORY)
================================ */
const ipHits = new Map();
const identityHits = new Map();

const WINDOW_MS = 15 * 60 * 1000;
const IP_LIMIT = 30;
const ID_LIMIT = 10;

function hit(map, key, limit) {
  const now = Date.now();
  const record = map.get(key) || { count: 0, start: now };

  if (now - record.start > WINDOW_MS) {
    record.count = 0;
    record.start = now;
  }

  record.count += 1;
  map.set(key, record);

  return record.count > limit;
}

/* ================================
   HELPERS
================================ */
function normalizePhone(input) {
  if (!input) return null;
  let p = input.replace(/\D/g, "");
  if (p.length === 10) return "+91" + p;
  if (p.startsWith("91") && p.length === 12) return "+" + p;
  if (p.startsWith("+") && p.length >= 12) return p;
  return null;
}

function normalizeOrderId(input) {
  if (!input) return null;
  if (input.startsWith("#")) return input;
  if (/^\d+$/.test(input)) return `#HS${input}`;
  return input;
}

/* ================================
   HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

/* ================================
   CUSTOMER TRACKING (SECURED)
================================ */
app.post("/track/customer", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

    if (hit(ipHits, ip, IP_LIMIT)) {
      return res.status(429).json({ error: "Too many requests. Try later." });
    }

    let { phone, email, order_id, awb } = req.body;

    phone = normalizePhone(phone);
    order_id = normalizeOrderId(order_id);

    /* 🔐 SECURITY RULE */
    if ((order_id || awb) && !phone && !email) {
      return res.status(400).json({
        error: "Phone or email required for verification"
      });
    }

    if (!phone && !email) {
      return res.status(400).json({
        error: "Phone or email required"
      });
    }

    const identityKey = phone || email || order_id || awb;
    if (hit(identityHits, identityKey, ID_LIMIT)) {
      return res.status(429).json({
        error: "Too many attempts for this identifier"
      });
    }

    const params = [];
    const where = [];

    if (phone) {
      params.push(phone);
      where.push(`customer_mobile = $${params.length}`);
    }

    if (email) {
      params.push(email);
      where.push(`customer_email = $${params.length}`);
    }

    if (order_id) {
      params.push(order_id);
      where.push(`shopify_order_name = $${params.length}`);
    }

    if (awb) {
      params.push(awb);
      where.push(`awb = $${params.length}`);
    }

    const { rows } = await pool.query(
      `
      SELECT *
      FROM shipments
      WHERE (${where.join(" OR ")})
      ORDER BY created_at DESC
      `,
      params
    );

    if (!rows.length) {
      return res.json({ error: "No orders found" });
    }

    const active = rows.filter(r => !r.delivery_confirmed);

    if (active.length > 0) {
      return res.json({
        mode: "ACTIVE_ONLY",
        count: active.length,
        orders: active
      });
    }

    const latestDelivered = rows
      .filter(r => r.delivery_confirmed)
      .sort((a, b) => new Date(b.delivered_at) - new Date(a.delivered_at))
      .slice(0, 1);

    return res.json({
      mode: "LATEST_DELIVERED",
      count: latestDelivered.length,
      orders: latestDelivered
    });

  } catch (err) {
    console.error("❌ Tracking error", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

/* ================================
   START SERVER
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics secured on port", PORT)
);