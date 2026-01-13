import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Environment variables (must be set in Render)
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const LOGIN_ID = process.env.LOGIN_ID;
const LICENCE_KEY = process.env.LICENCE_KEY;

// Basic startup log
console.log("Starting Blue Dart EDD test server");
console.log("Env check:", {
  CLIENT_ID: !!CLIENT_ID,
  CLIENT_SECRET: !!CLIENT_SECRET,
  LOGIN_ID: !!LOGIN_ID,
  LICENCE_KEY: !!LICENCE_KEY
});

// 🔴 DO NOT CACHE TOKEN — portal does not cache
async function generateToken() {
  const res = await axios.get(
    "https://apigateway.bluedart.com/in/transportation/token/v1/login",
    {
      headers: {
        ClientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        Accept: "application/json"
      }
    }
  );

  if (!res.data?.JWTToken) {
    throw new Error("JWTToken not returned from auth API");
  }

  return res.data.JWTToken;
}

// 🔍 EXACT PORTAL REPLICATION ENDPOINT
app.post("/edd", async (req, res) => {
  try {
    console.log("---- /edd TEST CALL START ----");

    // 1️⃣ Generate JWT
    const token = await generateToken();
    console.log("JWT generated");

    // 2️⃣ Call SAME API portal uses (NEW transit-time API)
    const response = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit-time/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: "400099",
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: "20260116",
        pPickupTime: "1600",
        profile: {
          Api_type: "T",
          LicenceKey: LICENCE_KEY,
          LoginID: LOGIN_ID
        }
      },
      {
        headers: {
          // ⚠️ EXACTLY what portal sends
          JWTToken: token,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    console.log("Blue Dart response OK");

    // 3️⃣ Return raw response (no processing)
    res.json(response.data);
  } catch (error) {
    console.error("❌ FAILURE");

    console.error({
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });

    res.status(500).json({
      error: "FAILED",
      status: error.response?.status,
      details: error.response?.data || error.message
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("Blue Dart EDD test server running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
