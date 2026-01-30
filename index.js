import express from "express";
import pg from "pg";

/* ===============================
   🚀 APP + DB
================================ */
const app = express();
app.use(express.json());

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===============================
   🌍 CORS
================================ */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

console.log("🚀 Ops Logistics running");

/* ===============================
   🧭 OPS DASHBOARD (READ ONLY)
================================ */
app.get("/ops/dashboard", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        awb,
        actual_courier,
        last_known_status,
        delivered_at,
        first_ndr_at,
        next_check_at,
        ops_note,
        ops_resolved_at
      FROM shipments
      WHERE ops_resolved_at IS NULL
    `);

    const now = new Date();

    const attention = [];
    const ndr = [];
    const outForDelivery = [];

    for (const r of rows) {
      const status = (r.last_known_status || "").toUpperCase();
      const delivered = !!r.delivered_at;

      if (!delivered && r.next_check_at && new Date(r.next_check_at) < now) {
        attention.push(r);
      }

      if (!delivered && (status.includes("NDR") || r.first_ndr_at)) {
        ndr.push(r);
      }

      if (!delivered && status.includes("OUT FOR DELIVERY")) {
        outForDelivery.push(r);
      }
    }

    res.json({
      attention,
      ndr,
      out_for_delivery: outForDelivery
    });
  } catch (err) {
    console.error("OPS DASHBOARD ERROR", err);
    res.status(500).json({ error: "ops_dashboard_failed" });
  }
});

/* ===============================
   ✍️ OPS NOTE (ADD / UPDATE)
================================ */
app.post("/ops/note", async (req, res) => {
  const { awb, note } = req.body;

  if (!awb || !note) {
    return res.status(400).json({ error: "awb_and_note_required" });
  }

  try {
    await pool.query(
      `UPDATE shipments SET ops_note=$1, updated_at=NOW() WHERE awb=$2`,
      [note, awb]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("OPS NOTE ERROR", err);
    res.status(500).json({ error: "ops_note_failed" });
  }
});

/* ===============================
   ✅ OPS RESOLVE
================================ */
app.post("/ops/resolve", async (req, res) => {
  const { awb } = req.body;

  if (!awb) {
    return res.status(400).json({ error: "awb_required" });
  }

  try {
    await pool.query(
      `UPDATE shipments SET ops_resolved_at=NOW(), updated_at=NOW() WHERE awb=$1`,
      [awb]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("OPS RESOLVE ERROR", err);
    res.status(500).json({ error: "ops_resolve_failed" });
  }
});

/* ===============================
   ❤️ HEALTH
================================ */
app.get("/health", (_req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Server on", PORT);
});