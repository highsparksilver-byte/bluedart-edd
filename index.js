<script>
(function () {
  const textEl = document.getElementById("edd-text");
  const countdownEl = document.getElementById("edd-countdown");
  const pincodeInput = document.getElementById("edd-pincode");
  const checkBtn = document.getElementById("edd-check");

  let countdownTimer = null;

  function getISTNow() {
    return new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
  }

  function formatDate(date) {
    return date.toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long"
    });
  }

  /*
    ✅ FINAL SAFE PICKUP LOGIC
    - Add +1 day ONLY if pickup cutoff missed (after 11 AM)
    - No Sunday logic here
    - No date-equality checks
  */
  function adjustEDDForPickup(eddDate) {
    const now = getISTNow();

    if (now.getHours() >= 11) {
      eddDate.setDate(eddDate.getDate() + 1);
    }

    return eddDate;
  }

  /*
    Countdown = pickup cutoff
    Sunday pickup closed
  */
  function getNextCutoff() {
    const now = getISTNow();
    const cutoff = new Date(now);
    cutoff.setHours(11, 0, 0, 0);

    if (now >= cutoff) {
      cutoff.setDate(cutoff.getDate() + 1);
    }

    // Skip Sunday for pickup
    if (cutoff.getDay() === 0) {
      cutoff.setDate(cutoff.getDate() + 1);
    }

    return cutoff;
  }

  function startCountdown(cutoff) {
    if (countdownTimer) clearInterval(countdownTimer);

    function update() {
      const diff = cutoff - getISTNow();
      if (diff <= 0) {
        countdownEl.textContent = "";
        clearInterval(countdownTimer);
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff / (1000 * 60)) % 60);

      countdownEl.textContent =
        `Order within ${hours} hours ${minutes} minutes.`;
    }

    update();
    countdownTimer = setInterval(update, 60000);
  }

  async function fetchEDD(pincode) {
    textEl.textContent = "Checking delivery date…";
    countdownEl.textContent = "";

    try {
      const response = await fetch(
        "https://bluedart-edd.onrender.com/edd",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pincode })
        }
      );

      const data = await response.json();

      if (!data.edd) {
        textEl.textContent = "Unable to check delivery date";
        return;
      }

      const [day, mon, year] = data.edd.split("-");
      let eddDate = new Date(`${day} ${mon} 20${year}`);

      eddDate = adjustEDDForPickup(eddDate);

      textEl.innerHTML =
        `<strong>Free Delivery by ${formatDate(eddDate)}</strong>`;

      startCountdown(getNextCutoff());

    } catch (err) {
      console.error("EDD error:", err);
      textEl.textContent = "Unable to check delivery date";
    }
  }

  checkBtn.addEventListener("click", () => {
    const pin = pincodeInput.value.trim();
    if (!/^[0-9]{6}$/.test(pin)) {
      textEl.textContent = "Please enter a valid 6-digit pincode";
      countdownEl.textContent = "";
      return;
    }
    fetchEDD(pin);
  });
})();
</script>
