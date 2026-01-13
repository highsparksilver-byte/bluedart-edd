import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// 🔴 HARD-CODED — THIS IS WHAT WORKED
// Use a FRESH JWT generated from Blue Dart portal
const JWT_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdWJqZWN0LXN1YmplY3QiLCJhdWQiOlsiYXVkaWVuY2UxIiwiYXVkaWVuY2UyIl0sImlzcyI6InVybjovL2FwaWdlZS1lZGdlLUpXVC1wb2xpY3ktdGVzdCIsImV4cCI6MTc2ODQwOTYwNSwiaWF0IjoxNzY4MzIzMjA1LCJqdGkiOiI5MGExZjQ2ZS00NzMzLTQ1OTAtODFjOS04YWUxZGNiYWZhZWMifQ.NIQDd34M0YDSbm5anjaEg0PXfK5Tn32Md9gguGQ5enI";

// These MUST match the same account that generated the JWT
const LOGIN_ID = "PNQ90609";              // example – replace with yours
const LICENCE_KEY = "oupkkkosmeqmuqqfsph8korrp8krmouj";   // replace with yours

// Legacy date format (required)
function legacyDate() {
  return `/Date(${Date.now()})/`;
}

// ✅ THIS ENDPOINT WORKED
app.post("/edd", async (req, res) => {
  try {
    const response = await axios.post(
      "https://apigateway.bluedart.com/in/transportation/transit/v1/GetDomesticTransitTimeForPinCodeandProduct",
      {
        pPinCodeFrom: "411022",
        pPinCodeTo: "400099",
        pProductCode: "A",
        pSubProductCode: "P",
        pPudate: legacyDate(),
        pPickupTime: "16:00",
        profile: {
          Api_type: "S",
          LicenceKey: LICENCE_KEY,
          LoginID: LOGIN_ID
        }
      },
      {
        headers: {
          JWTToken: JWT_TOKEN,
          "Content-Type": "application/json",
          Accept: "application/json"
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    res.status(500).json({
      error: "FAILED",
      status: error.response?.status,
      details: error.response?.data || error.message
    });
  }
});

app.get("/", (req, res) => {
  res.send("Blue Dart EDD server running (known-good version)");
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
