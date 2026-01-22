import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

/* =========================
   HEALTH CHECK (MANDATORY)
========================= */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* =========================
   CONFIG (ENV VARIABLES)
========================= */
const CLIENT_ID = process.env.BLUEDART_CLIENT_ID;
const CLIENT_SECRET = process.env.BLUEDART_CLIENT_SECRET;
const LOGIN_ID = process.env.BLUEDART_LOGIN_ID;
const LICENCE_KEY = process.env.BLUEDART_LICENCE_KEY;

/* =========================
   GENERATE JWT TOKEN
========================= */
async function generateJWT() {
  const response = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        Accept: "application/json",
        ClientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      }
    }
  );

  return response.data.JWTToken;
}

/* =========================
   EDD ENDPOINT
========================= */
app.post("/edd", async (req, res) => {
  try {
    const { from_pincode, to_pincode } = req.body;

    if (!from_pincode || !to_pincode) {
      return res.status(400).json({ error: "Missing pincode" });
    }

    // 1️⃣ Generate JWT
    const jwtToken = await generateJWT();

    // 2️⃣ Build Blue Dart request
    const payload = {
      pPinCodeFrom: from_pincode,
      pPinCodeTo: to_pincode,
      pProductCode: "A",
      pSubProductCode: "P",
      pPudate: `/Date(${Date.now()})/`,
      pPickupTime: "16:00",
      profile: {
        Api_type: "S",
        LicenceKey: LICENCE_KEY,
        LoginID: LOGIN_ID
      }
    };

    // 3️⃣ Call Blue Dart Transit API
    const bdResponse = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          JWTToken: jwtToken
        }
      }
    );

    const result =
      bdResponse.data?.GetDomesticTransitTimeForPinCodeandProductResult;

    if (!result || result.IsError) {
      return res.status(500).json({ error: "EDD unavailable" });
    }

    // 4️⃣ Return ONLY the EDD (Shopify friendly)
    return res.json({
      edd: result.ExpectedDateDelivery
    });
  } catch (err) {
    console.error("EDD ERROR:", err.response?.data || err.message);
    return res.status(500).json({
      error: "EDD unavailable"
    });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
``
