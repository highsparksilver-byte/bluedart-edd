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
   🔑 CONFIG
================================================= */
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY_TRACK = process.env.BD_LICENCE_KEY_TRACK;

console.log("🚀 Ops Logistics starting (Phase 5.3)");

/* =================================================
   🧠 NEXT-CHECK CALCULATOR (TRAFFIC LIGHT)
================================================= */
function calculateNextCheck(statusType) {
  const now = new Date();

  // 🔴 STOP FOREVER
  if (statusType === "DL" || statusType === "RT") {
    return new Date("9999-01-01");
  }

  // 🟢 FAST LANE
  if (statusType === "UD") {
    return new Date(now.getTime() + 1 * 60 * 60 * 1000); // +1 hour
  }

  // 🟡 SLOW LANE
  if (statusType === "IT") {
    return new Date(now.getTime() + 12 * 60 * 60 * 1000); // +12 hours
  }

  // ⚪ SAFETY
  return new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24 hours
}

/* =================================================
   📦 BLUE DART — BATCH TRACKING
================================================= */
async function trackBluedartBatch(awbs) {
  try {
    const url =
      "https://api.bluedart.com/servlet/RoutingServlet" +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awbs.join(",")}` +
      `&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    console.log(`📡 Blue Dart batch call (${awbs.length} AWBs)`);

    const res = await axios.get(url, {
      responseType: "text",
      timeout: 12000,
    });

    console.log("📄 RAW BD XML (batch)");

    const parsed = await new Promise((resolve, reject) =>
      xml2js.parseString(
        res.data,
        { explicitArray: false },
        (err, r) => (err ? reject(err) : resolve(r))
      )
    );

    let shipments = parsed?.ShipmentData?.Shipment;
    if (!shipments) return {};

    if (!Array.isArray(shipments)) shipments = [shipments];

    const map = {};
    for (const s of shipments) {
      map[s.$.WaybillNo] = {
        status: s.Status,
        statusType: s.StatusType,
      };
    }

    return map;
  } catch (err) {
    console.error("❌ Blue Dart batch failed:", err.message);
    return {};
  }
}

/* =================================================
   ⏱️ CRON SYNC
================================================= */
app.post("/_cron/sync", async (_, res) => {
  console.log("🕒 Cron sync started (batched)");

  try {
    const { rows } = await pool.query(`
      SELECT id, awb
      FROM shipments
      WHERE courier = 'bluedart'
        AND delivery_confirmed = false
        AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      LIMIT 25
    `);

    console.log(`📦 Due shipments: ${rows.length}`);
    if (rows.length === 0) {
      return res.json({ ok: true, processed: 0 });
    }

    const awbs = rows.map(r => r.awb);
    const results = await trackBluedartBatch(awbs);

    let processed = 0;

    for (const row of rows) {
      const data = results[row.awb];

      if (!data) {
        console.log(`⏭️ No tracking for ${row.awb}`);
        continue;
      }

      const nextCheck = calculateNextCheck(data.statusType);

      console.log(`✅ ${row.awb} → ${data.statusType}`);
      console.log(`🧠 Next check at: ${nextCheck.toISOString()}`);

      await pool.query(
        `
        UPDATE shipments
        SET
          last_known_status = $1,
          last_checked_at = NOW(),
          next_check_at = $2,
          delivery_confirmed = $3,
          delivered_at = CASE WHEN $3 THEN NOW() ELSE delivered_at END
        WHERE awb = $4
        `,
        [
          data.status,
          nextCheck,
          data.statusType === "DL" || data.statusType === "RT",
          row.awb,
        ]
      );

      processed++;
    }

    console.log(`🏁 Cron finished | Processed: ${processed}`);
    res.json({ ok: true, processed });

  } catch (err) {
    console.error("🔥 Cron sync crashed");
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   🚀 START
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Server running on port", PORT)
);
