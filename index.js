import express from "express";
import axios from "axios";
import xml2js from "xml2js";
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

/* =================================================
   🔑 ENV
================================================= */
const clean = (v) => v?.replace(/\r|\n|\t/g, "").trim();

const LOGIN_ID = clean(process.env.LOGIN_ID);
const BD_LICENCE_KEY_TRACK = clean(process.env.BD_LICENCE_KEY_TRACK);

console.log("🚀 Ops Logistics server starting…");

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   📦 BLUEDART TRACK (SINGLE / BATCH SAFE)
================================================= */
async function trackBluedartBatch(awbs) {
  try {
    const awbString = awbs.join(",");
    const url =
      "https://api.bluedart.com/servlet/RoutingServlet" +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awbString}&format=xml&lickey=${BD_LICENCE_KEY_TRACK}&verno=1&scan=1`;

    const res = await axios.get(url, { responseType: "text", timeout: 15000 });

    const parsed = await new Promise((resolve, reject) =>
      xml2js.parseString(res.data, { explicitArray: false }, (err, r) =>
        err ? reject(err) : resolve(r)
      )
    );

    const shipments = parsed?.ShipmentData?.Shipment;
    if (!shipments) return {};

    const list = Array.isArray(shipments) ? shipments : [shipments];

    const result = {};
    for (const s of list) {
      result[s.WaybillNo] = {
        status: s.Status,
        statusType: s.StatusType,
      };
    }
    return result;
  } catch {
    return {};
  }
}

/* =================================================
   ⏱️ CRON — SMART SYNC (BATCHED)
================================================= */
app.post("/_cron/sync", async (req, res) => {
  try {
    console.log("🕒 Cron sync started (batched)");

    const { rows } = await pool.query(`
      SELECT id, awb
      FROM shipments
      WHERE courier = 'bluedart'
        AND delivery_confirmed = false
        AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      LIMIT 25
    `);

    console.log("📦 Due shipments:", rows.length);

    if (rows.length === 0) {
      return res.json({ ok: true, processed: 0 });
    }

    const awbs = rows.map(r => r.awb);
    const tracking = await trackBluedartBatch(awbs);

    let processed = 0;

    for (const row of rows) {
      const t = tracking[row.awb];
      if (!t) continue;

      let nextCheck;
      let delivered = false;

      if (t.statusType === "DL" || t.statusType === "RT") {
        delivered = true;
        nextCheck = "9999-01-01";
      } else if (t.statusType === "UD") {
        nextCheck = new Date(Date.now() + 60 * 60 * 1000); // 1 hr
      } else {
        nextCheck = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hr
      }

      await pool.query(
        `
        UPDATE shipments
        SET
          last_known_status = $1,
          last_checked_at = NOW(),
          delivery_confirmed = $2,
          delivered_at = CASE WHEN $2 THEN NOW() ELSE delivered_at END,
          next_check_at = $3
        WHERE awb = $4
        `,
        [t.status, delivered, nextCheck, row.awb]
      );

      processed++;
    }

    console.log("🏁 Cron finished | Processed:", processed);
    res.json({ ok: true, processed });

  } catch (err) {
    console.error("❌ Cron failed", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   📦 PHASE 8.4 — CUSTOMER TRACKING
================================================= */
app.post("/track/customer", async (req, res) => {
  try {
    let { phone, email, order_id } = req.body;

    // Normalize phone (India)
    if (phone) {
      phone = phone.replace(/\D/g, "");
      if (phone.length === 10) phone = `+91${phone}`;
      if (phone.startsWith("91") && phone.length === 12) phone = `+${phone}`;
    }

    // Normalize order id
    if (order_id) {
      order_id = order_id.toUpperCase();
      if (!order_id.startsWith("#")) order_id = `#${order_id}`;
      if (!order_id.startsWith("#HS"))
        order_id = `#HS${order_id.replace("#", "")}`;
    }

    if (!phone && !email && !order_id) {
      return res.status(400).json({ error: "Phone, email or order_id required" });
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
      conditions.push(`shopify_order_name = $${values.length}`);
    }

    const { rows } = await pool.query(
      `
      SELECT *
      FROM shipments
      WHERE ${conditions.join(" OR ")}
      ORDER BY created_at DESC
      `,
      values
    );

    if (rows.length === 0) {
      return res.json({ error: "No orders found" });
    }

    const active = rows.filter(r => !r.delivery_confirmed);
    const result = active.length > 0 ? active : [rows[0]];

    res.json({
      mode: active.length > 0 ? "ACTIVE_ONLY" : "LATEST_DELIVERED",
      count: result.length,
      orders: result,
    });

  } catch (err) {
    console.error("❌ Customer tracking failed", err.message);
    res.status(500).json({ error: "Tracking failed" });
  }
});

/* =================================================
   🚀 START SERVER
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Ops Logistics running on port ${PORT}`)
);