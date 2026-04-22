//The MIT License
//
//Copyright (c) 2018 Athanasios Andreou, <andreou@eurecom.fr>
//
//Permission is hereby granted, free of charge,
//to any person obtaining a copy of this software and
//associated documentation files (the "Software"), to
//deal in the Software without restriction, including
//without limitation the rights to use, copy, modify,
//merge, publish, distribute, sublicense, and/or sell
//copies of the Software, and to permit persons to whom
//the Software is furnished to do so,
//subject to the following conditions:
//
//The above copyright notice and this permission notice
//shall be included in all copies or substantial portions of the Software.
//
//THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
//EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
//OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
//IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR
//ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
//TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
//SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// ===============================
// CheckMyNews - popup.js (MV3)
// Works with your original HTML
// ===============================

const CONSENT_PAGE = "ui/new_consent.html";

const BASE_URL = "https://adanalystplus.lix.polytechnique.fr";

// Hide everything initially
$("#normalView").hide();
$("#notLoggedInView").hide();
$("#consentForm").hide();

// -------------------------------
// 1. Load Consent Status
// -------------------------------
function loadConsentStatus() {
  chrome.runtime.sendMessage({ type: "getConsentStatus" }, (response) => {
    if (chrome.runtime.lastError) {
      setTimeout(loadConsentStatus, 3000);
      return;
    }
    if (!response || !response.ok) {
      setTimeout(loadConsentStatus, 3000);
      return;
    }

    const hasConsent = response.consent === true;

    // Consent given → show normal view with links
    if (hasConsent) {
      const uid = response.currentUser;
      $("#general_statistics").attr(
        "href",
        `${BASE_URL}/general_statistics?user=${uid}`
      );
      $("#contact_us").attr("href", `${BASE_URL}/contact_us`);
      $("#normalView").show();
      $("#notLoggedInView").hide();
      $("#consentForm").hide();
      return;
    }

    // No consent → open consent page (works with or without Facebook login)
    chrome.tabs.create({ url: chrome.runtime.getURL("ui/new_consent.html") });
    window.close();
  });
}

// -------------------------------
// 2. Register Consent
// -------------------------------
function registerConsent() {
  chrome.runtime.sendMessage(
    { type: "registerConsent", payload: { consent: true } },
    (response) => {
      if (chrome.runtime.lastError) {
        return;
      }
      if (response && response.ok) {
        $("#consentForm").hide();
        $("#normalView").show();
      } else {
        alert("Something went wrong. Please try again.");
      }
    }
  );
}

// -------------------------------
// 3. Open dedicated consent page
// -------------------------------
function openConsentPage() {
  chrome.tabs.create({
    url: chrome.runtime.getURL(CONSENT_PAGE),
  });
}

// -------------------------------
// 4. Load Ads Summary
// -------------------------------
function loadAdsSummary() {
  chrome.runtime.sendMessage({ type: "getAdsSummary" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (!response || !response.ads) return;
    $("#adsCount").text(response.ads.count || 0);
  });
}

// -------------------------------
// 5. Load News Summary
// -------------------------------
function loadNewsSummary() {
  chrome.runtime.sendMessage({ type: "getNewsActivity" }, (response) => {
    if (chrome.runtime.lastError) return;
    if (!response || !response.activity) return;
    $("#newsCount").text(Object.keys(response.activity).length);
  });
}

// -------------------------------
// 6. UI Initialization
// -------------------------------
$(document).ready(function () {
  loadConsentStatus();
  loadAdsSummary();
  loadNewsSummary();

  // Buttons
  $("#consentButton").click(registerConsent);
  $("#privacyPolicy").click(openConsentPage);

  $("#remindMeTomorrow").click(() => window.close());
  $("#remindMeInTwelve").click(() => window.close());

  $("#noConsentButton").click(() => {
    chrome.tabs.create({ url: "chrome://extensions/" });
    window.close();
  });

  $("#refreshAds").click(loadAdsSummary);
});
