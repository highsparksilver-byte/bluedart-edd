import express from "express";
import axios from "axios";
import xml2js from "xml2js";
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
        next_check_at
      FROM shipments
    `);

    const now = new Date();

    const attention = [];
    const ndr = [];
    const outForDelivery = [];

    for (const r of rows) {
      const status = (r.last_known_status || "").toUpperCase();
      const delivered = !!r.delivered_at;

      if (!delivered && r.next_check_at && new Date(r.next_check_at) < now) {
        attention.push({
          awb: r.awb,
          courier: r.actual_courier,
          status: r.last_known_status,
          next_check_at: r.next_check_at
        });
      }

      if (
        !delivered &&
        (status.includes("NDR") || r.first_ndr_at)
      ) {
        ndr.push({
          awb: r.awb,
          courier: r.actual_courier,
          status: r.last_known_status,
          first_ndr_at: r.first_ndr_at
        });
      }

      if (
        !delivered &&
        status.includes("OUT FOR DELIVERY")
      ) {
        outForDelivery.push({
          awb: r.awb,
          courier: r.actual_courier,
          status: r.last_known_status
        });
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
   ❤️ HEALTH
================================ */
app.get("/health", (_req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Server on", PORT);
});