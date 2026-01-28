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

console.log("🚀 Ops Logistics starting…");

/* =================================================
   📦 BLUEDART TRACKING
================================================= */
async function trackBluedart(awb) {
  try {
    const url =
      "https://api.bluedart.com/servlet/RoutingServlet" +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${LICENCE_KEY_TRACK}&verno=1&scan=1`;

    console.log(`📡 Calling Blue Dart for ${awb}`);

    const res = await axios.get(url, { responseType: "text", timeout: 10000 });

    console.log(`📄 RAW BD XML for ${awb}:\n${res.data}`);

    const parsed = await new Promise((resolve, reject) =>
      xml2js.parseString(res.data, { explicitArray: false }, (err, r) =>
        err ? reject(err) : resolve(r)
      )
    );

    const shipment = parsed?.ShipmentData?.Shipment;
    if (!shipment || !shipment.StatusType) return null;

    return {
      status: shipment.Status,
      statusType: shipment.StatusType,
    };
  } catch (err) {
    console.error(`❌ Blue Dart API failed for ${awb}`);
    console.error(err.message);
    return null;
  }
}

/* =================================================
   🧠 TRAFFIC LIGHT SCHEDULER
================================================= */
function calculateNextCheck(statusType) {
  const now = new Date();

  if (statusType === "DL" || statusType === "RT") {
    return new Date("9999-01-01T00:00:00Z");
  }

  if (statusType === "UD") {
    return new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1 hour
  }

  if (statusType === "IT" || statusType === "PU") {
    return new Date(now.getTime() + 12 * 60 * 60 * 1000); // 12 hours
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000); // fallback
}

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   ⏱️ CRON SYNC
================================================= */
app.post("/_cron/sync", async (_, res) => {
  console.log("🕒 Cron sync started");

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

    console.log(`📦 DB rows fetched: ${rows.length}`);

    let processed = 0;

    for (const row of rows) {
      const { id, awb } = row;
      console.log(`➡️ Processing AWB: ${awb}`);

      const tracking = await trackBluedart(awb);
      if (!tracking) {
        console.log(`⏭️ Skipping AWB (no tracking): ${awb}`);
        continue;
      }

      const { status, statusType } = tracking;
      const nextCheck = calculateNextCheck(statusType);

      console.log(`✅ Status for ${awb}: ${statusType}`);
      console.log(`⏭️ Next check at: ${nextCheck.toISOString()}`);

      await pool.query(
        `
        UPDATE shipments
        SET
          last_known_status = $1,
          last_checked_at = NOW(),
          delivery_confirmed = $2,
          delivered_at = CASE WHEN $2 = true THEN NOW() ELSE delivered_at END,
          next_check_at = $3,
          updated_at = NOW()
        WHERE id = $4
        `,
        [
          status,
          statusType === "DL" || statusType === "RT",
          nextCheck,
          id,
        ]
      );

      processed++;
    }

    console.log(`🏁 Cron sync finished | Processed: ${processed}`);

    res.json({ ok: true, processed });
  } catch (err) {
    console.error("🔥 Cron sync crashed");
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =================================================
   🚀 START SERVER
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
