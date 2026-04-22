export const state = {
  CURRENT_USER_ID: null,
  LOGGED_IN: false,
  CONSENT: {},
  LANGUAGE: null,

  // queues, counters, timestamps
  EXPLANATION_QUEUE: [],
  MEDIA_REQUESTS: {},
  MEDIA_REQUEST_ID: 0,
  lastLanguageCheck: 0,

  initialized: false,
};

export async function initState(state) {
  // future: load persisted values if needed
}
