// content-scripts/fbMessageHandler.js

class FBMessageHandler {
  constructor() {
    this.listeners = new Map();
    this.setupListeners();
  }

  // Setup message listeners
  setupListeners() {
    // Listen to messages from background
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // Keep channel open for async
    });

    // Listen to messages from MAIN world (via window.postMessage)
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (event.data?.source !== "CMN") return;

      this.handleMainWorldMessage(event.data);
    });

  }

  // Handle message from background
  handleMessage(message, sender, sendResponse) {

    switch (message.type) {
      case "GET_STATS":
        this.emit("stats-requested", { sendResponse });
        break;

      case "START_MONITORING":
        this.emit("start-monitoring", {});
        sendResponse({ success: true, monitoring: true });
        break;

      case "STOP_MONITORING":
        this.emit("stop-monitoring", {});
        sendResponse({ success: true, monitoring: false });
        break;

      case "CLEAR_QUEUE":
        this.emit("clear-queue", {});
        sendResponse({ success: true });
        break;

      case "GET_CONFIG":
        this.emit("config-requested", { sendResponse });
        break;

      case "UPDATE_CONFIG":
        this.emit("config-updated", { config: message.config, sendResponse });
        break;

      default:
        sendResponse({ error: "Unknown message type" });
    }
  }

  // Handle message from MAIN world
  handleMainWorldMessage(data) {

    switch (data.type) {
      case "USER_ID":
        this.sendToBackground("userIdDetected", { userId: data.userId });
        break;

      case "UI_DETECTED":
        this.sendToBackground("ui-detection", {
          version: data.version,
          mobile: data.mobile,
        });
        break;

      default:
    }
  }

  // Send message to background
  async sendToBackground(type, data = {}) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: type,
        ...data,
        timestamp: Date.now(),
      });

      return response;
    } catch (error) {
      throw error;
    }
  }

  // Send to MAIN world
  sendToMainWorld(type, data = {}) {
    window.postMessage(
      {
        source: "CMN_CONTENT",
        type: type,
        ...data,
      },
      "*"
    );
  }

  // Event emitter pattern
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  off(event, callback) {
    if (!this.listeners.has(event)) return;
    const callbacks = this.listeners.get(event);
    const index = callbacks.indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
    }
  }

  emit(event, data) {
    if (!this.listeners.has(event)) return;
    const callbacks = this.listeners.get(event);
    callbacks.forEach((callback) => {
      try {
        callback(data);
      } catch (error) {
      }
    });
  }

  // Request injection of MAIN world scripts
  async requestInjection(scriptName) {
    return this.sendToBackground("injectScript", { scriptName });
  }
}

// Export
window.FBMessageHandler = FBMessageHandler;
