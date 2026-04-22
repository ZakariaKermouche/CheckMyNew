// background/heartbeat.js
import { processExplanationsQueue } from "./explanations.js";
import { getConsentStatus } from "./consent.js"; // optional
import { updateCurrentUser } from "./user.js"; // optional
import { state, URLS_SERVER } from "./state.js"; // imports that exist in your new architecture

const HEARTBEAT_ALARM = "cmn_heartbeat";

// ------------------------------------------------------
// INIT heartbeat
// ------------------------------------------------------
export async function initHeartbeatSystem() {

  // Create alarm every X minutes
  chrome.alarms.create(HEARTBEAT_ALARM, {
    periodInMinutes: 5, // you can change to 1, 2, or 10 min
  });

  // Listener for alarms
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== HEARTBEAT_ALARM) return;

    try {
      // OPTIONAL: keep user & consent fresh
      await updateCurrentUser(state);
      await getConsentStatus(state);

      // IMPORTANT → process explanations queue
      await processExplanationsQueue(state, URLS_SERVER);

      // You can also call your other “periodic” subsystems here:
      // await processClickedAdsQueue(state, URLS_SERVER);
      // await processPreferencesQueue(state, URLS_SERVER);
      // await processAdvertisersQueue(state, URLS_SERVER);
    } catch (e) {
    }
  });

}
