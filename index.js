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
   🌍 CORS (SAFE)
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

/* =================================================
   📦 BLUE DART TRACKING
================================================= */
async function trackBluedart(awb) {
  try {
    const url =
      "https://api.bluedart.com/servlet/RoutingServlet" +
      `?handler=tnt&action=custawbquery&loginid=${LOGIN_ID}` +
      `&awb=awb&numbers=${awb}&format=xml&lickey=${BD_LICENCE_KEY_TRACK}` +
      `&verno=1&scan=1`;

    const res = await axios.get(url, {
      responseType: "text",
      timeout: 15000,
    });

    console.log("📄 RAW BD XML:", res.data);

    const parsed = await new Promise((resolve, reject) =>
      xml2js.parseString(
        res.data,
        { explicitArray: false },
        (err, r) => (err ? reject(err) : resolve(r))
      )
    );

    const shipment = parsed?.ShipmentData?.Shipment;
    if (!shipment || !shipment.StatusType) return null;

    return {
      status: shipment.Status,
      statusType: shipment.StatusType,
    };
  } catch (err) {
    console.error("❌ Blue Dart API failed for", awb);
    console.error(err.message);
    return null;
  }
}

/* =================================================
   ❤️ HEALTH
================================================= */
app.get("/health", (_, res) => res.send("OK"));

/* =================================================
   ⏱️ CRON SYNC (MANUAL / SCHEDULER)
================================================= */
app.post("/_cron/sync", async (req, res) => {
  console.log("🕒 Cron sync started");

  try {
    const { rows } = await pool.query(`
      SELECT id, awb
      FROM shipments
      WHERE courier = 'bluedart'
        AND delivery_confirmed = false
        AND next_check_at <= NOW()
      ORDER BY next_check_at ASC
      LIMIT 10
    `);

    console.log("📦 DB rows fetched:", rows.length);

    let processed = 0;

    for (const row of rows) {
      console.log(`➡️ Processing AWB: ${row.awb}`);

      const tracking = await trackBluedart(row.awb);

      if (!tracking) {
        console.log(`⏭️ Skipping AWB (no tracking): ${row.awb}`);
        continue;
      }

      console.log(
        `✅ Blue Dart status for ${row.awb} → ${tracking.statusType}`
      );

      /* ===============================
         🎉 DELIVERED (FINAL)
      =============================== */
      if (tracking.statusType === "DL") {
        console.log(`🎉 Delivered: ${row.awb}`);

        await pool.query(
          `
          UPDATE shipments
          SET
            delivery_confirmed = true,
            last_known_status = $1,
            last_checked_at = NOW(),
            delivered_at = NOW(),
            next_check_at = TIMESTAMP '9999-01-01'
          WHERE id = $2
          `,
          [tracking.status, row.id]
        );

        processed++;
        continue;
      }

      /* ===============================
         🚚 NOT FINAL → RESCHEDULE
      =============================== */
      await pool.query(
        `
        UPDATE shipments
        SET
          last_known_status = $1,
          last_checked_at = NOW(),
          next_check_at = NOW() + INTERVAL '12 hours'
        WHERE id = $2
        `,
        [tracking.status, row.id]
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
   🚀 START SERVER
================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🚀 Server running on port", PORT)
);
