const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment variables (from Render)
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENSE_KEY = process.env.LICENSE_KEY;

console.log("Server starting...");

let cachedToken = null;
let tokenExpiry = null;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const res = await axios.post(
    "https://apigateway-sandbox.bluedart.com/in/transportation/auth/v1/login",
    { clientId: CLIENT_ID },
    { headers: { clientSecret: CLIENT_SECRET } }
  );

  cachedToken = res.data.jwtToken;
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

// ✅ THIS IS THE IMPORTANT PART
app.post("/edd", async (req, res) => {
  try {
    console.log("EDD request received");

    const toPincode =
      req.body.pincode || req.query.pincode || "411022";

    const token = await getToken();

    const today = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

    const response = await axios.post(
      "https://apigateway-sandbox.bluedart.com/in/transportation/transittime/v1/getdomestictransittime",
      {
        ppinCode: "411022",
        pPinCodeTo: toPincode,
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: today,
        pPickupTime: "1400"
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          LoginID: LOGIN_ID,
          LicenseKey: LICENSE_KEY
        }
      }
    );

    const edd =
      response.data?.DomesticTranistTimeReference?.ExpectedDateDelivery;

    res.json({ edd });
  } catch (e) {
    console.error("EDD ERROR:", e.response?.data || e.message);
    res.status(500).json({
      error: "EDD unavailable",
      details: e.response?.data || e.message
    });
  }
});

// Optional health check
app.get("/", (req, res) => {
  res.send("Server alive");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
