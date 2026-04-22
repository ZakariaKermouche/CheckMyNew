// new_consent.js — MV3 version

const HOST_SERVER = "https://adanalystplus.lix.polytechnique.fr/";

// -----------------------------------------------------
// 1. Send consent to background service worker
// -----------------------------------------------------
function sendConsent() {
  chrome.runtime.sendMessage(
    { type: "registerConsent", payload: { consent: true } },
    (response) => {
      if (chrome.runtime.lastError) {
        showError();
        return;
      }

      if (!response || response.ok === false) {
        if (response && response.error === "no_user_id") {
          showNoUserIdMessage();
        } else {
          showError();
        }
        return;
      }

      // Consent registered → close page
      window.close();
    }
  );
}

// -----------------------------------------------------
// 2. Poll consent status — only started when consent is still needed
// -----------------------------------------------------
function pollConsentStatus() {
  chrome.runtime.sendMessage({ type: "getConsentStatus" }, (response) => {
    if (chrome.runtime.lastError) {
      setTimeout(pollConsentStatus, 5000);
      return;
    }
    if (!response || !response.ok) {
      setTimeout(pollConsentStatus, 5000);
      return;
    }

    if (response.consent === true) {
      window.close();
      return;
    }

    // User ID became available — enable the consent button
    if (response.currentUser) {
      $("#consentButton").prop("disabled", false);
      $("#noUserIdMsg").remove();
    }

    setTimeout(pollConsentStatus, 5000);
  });
}

// -----------------------------------------------------
// 3. UI helpers
// -----------------------------------------------------
function showError() {
  $("#consentInfo").append(`
    <div class="alert alert-danger alert-dismissable">
      <strong>Error:</strong> Something went wrong. Please try again.
    </div>
  `);
}

function showNoUserIdMessage() {
  if ($("#noUserIdMsg").length) return;
  $("#consentButton").before(`
    <div id="noUserIdMsg" class="alert alert-info" style="margin-top:10px">
      Please open Facebook in a tab first, then click <strong>I consent</strong> again.
    </div>
  `);
}

// -----------------------------------------------------
// 4. Bind UI
// -----------------------------------------------------
$(document).ready(function () {
  $("#consentButton").click(sendConsent);

  $("#noConsentButton").click(() => {
    chrome.tabs.create({ url: "chrome://extensions/" });
    window.close();
  });

  // Check initial state before starting the poll loop
  chrome.runtime.sendMessage({ type: "getConsentStatus" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      pollConsentStatus();
      return;
    }

    if (response.currentUser) {
      const contactUrl = "https://adanalystplus.lix.polytechnique.fr/contact_us?user=" + response.currentUser;
      $("#contactUsLink").attr("href", contactUrl).show();
    }

    if (response.consent === true) {
      // User already consented — this is a Privacy Policy review.
      // Hide the action buttons so the page stays open for reading.
      $("#consentButton").hide();
      $("#noConsentButton").hide();
      return;
    }

    if (!response.currentUser) {
      // No Facebook user ID yet — disable the button until detected
      $("#consentButton").prop("disabled", true);
      showNoUserIdMessage();
    }

    pollConsentStatus();
  });
});
