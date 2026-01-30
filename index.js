import express from "express";
import pg from "pg";
import crypto from "crypto";

const app = express();

/* ===============================
   RAW BODY (WEBHOOK SAFE)
================================ */
app.use(express.json());

/* ===============================
   DB
================================ */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   CONSTANTS
================================ */
const PPCOD_ADVANCE = 100;
const AD_SPEND = Number(process.env.MONTHLY_AD_SPEND || 0);

/* ===============================
   HELPERS
================================ */
function classifyRevenue(status, hoursSinceUpdate) {
  const s = (status || "").toUpperCase();

  if (s.includes("DELIVERED")) return "REALIZED";
  if (s.includes("OUT FOR")) return "PROBABLE";
  if (s.includes("IN TRANSIT")) return "PROBABLE";

  if (s.includes("NDR")) {
    if (hoursSinceUpdate <= 24) return "PROBABLE";
    if (hoursSinceUpdate <= 72) return "QUESTIONABLE";
    return "WEAK";
  }

  if (s.includes("RTO") || s.includes("CANCEL")) return "DEAD";
  return "UNKNOWN";
}

/* ===============================
   STEP 8.3 – RECON SUMMARY
================================ */
app.get("/recon/summary", async (_, res) => {
  const { rows: shipments } = await pool.query(`
    SELECT
      s.awb,
      s.last_known_status,
      s.updated_at,
      o.order_type,
      o.order_total,
      o.financial_status
    FROM shipments s
    LEFT JOIN orders_ops o ON o.shopify_order_name = s.order_name
  `);

  const counts = {
    delivered: 0,
    out_for_delivery: 0,
    in_transit: 0,
    ndr: 0,
    rto: 0
  };

  const revenue = {
    realized: 0,
    probable: 0,
    questionable: 0,
    dead: 0
  };

  const now = Date.now();

  for (const s of shipments) {
    const status = (s.last_known_status || "").toUpperCase();
    const hours =
      (now - new Date(s.updated_at).getTime()) / 36e5;

    // COUNT buckets
    if (status.includes("DELIVERED")) counts.delivered++;
    else if (status.includes("OUT FOR")) counts.out_for_delivery++;
    else if (status.includes("IN TRANSIT")) counts.in_transit++;
    else if (status.includes("NDR")) counts.ndr++;
    else if (status.includes("RTO") || status.includes("CANCEL"))
      counts.rto++;

    // REVENUE logic
    const bucket = classifyRevenue(status, hours);
    const total = Number(s.order_total || 0);

    if (s.order_type === "PPCOD") {
      revenue.realized += PPCOD_ADVANCE;
      if (bucket === "REALIZED") revenue.realized += total - PPCOD_ADVANCE;
      else if (bucket === "PROBABLE") revenue.probable += total - PPCOD_ADVANCE;
      else if (bucket === "QUESTIONABLE") revenue.questionable += total - PPCOD_ADVANCE;
      else revenue.dead += total - PPCOD_ADVANCE;
      continue;
    }

    if (bucket === "REALIZED") revenue.realized += total;
    else if (bucket === "PROBABLE") revenue.probable += total;
    else if (bucket === "QUESTIONABLE") revenue.questionable += total;
    else revenue.dead += total;
  }

  const acos = {
    worst_case: AD_SPEND / Math.max(revenue.realized, 1),
    probable_case: AD_SPEND / Math.max(revenue.realized + revenue.probable, 1),
    best_case:
      AD_SPEND /
      Math.max(
        revenue.realized + revenue.probable + revenue.questionable,
        1
      )
  };

  res.json({ counts, revenue, acos });
});

/* ===============================
   STEP 8.4 – DASHBOARD VIEW
================================ */
app.get("/recon/dashboard", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      s.awb,
      s.last_known_status,
      o.shopify_order_name,
      o.order_type,
      o.order_total
    FROM shipments s
    LEFT JOIN orders_ops o ON o.shopify_order_name = s.order_name
  `);

  res.json({ rows });
});

/* ===============================
   STEP 8.4 – CSV EXPORT
================================ */
app.get("/recon/export.csv", async (_, res) => {
  const { rows } = await pool.query(`
    SELECT
      s.awb,
      o.shopify_order_name,
      o.order_type,
      s.last_known_status,
      o.order_total
    FROM shipments s
    LEFT JOIN orders_ops o ON o.shopify_order_name = s.order_name
  `);

  let csv =
    "AWB,Order,Type,Status,OrderValue\n" +
    rows
      .map(
        r =>
          `${r.awb},${r.shopify_order_name},${r.order_type},${r.last_known_status},${r.order_total}`
      )
      .join("\n");

  res.header("Content-Type", "text/csv");
  res.send(csv);
});

/* ===============================
   HEALTH
================================ */
app.get("/health", (_, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("🚀 Ops Logistics running on", PORT)
);