chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  if (command === "release-bugs") {
    // Inject webgazer.js first
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["webgazer.min.js"]
    });
    
    // Then inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    
    chrome.tabs.sendMessage(tab.id, {
      type: "INJECT_BUGS",
      payload: { count: 12, size: 48, animate: true }
    });
  } else if (command === "clear-bugs") {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    chrome.tabs.sendMessage(tab.id, { type: "CLEAR_BUGS" });
  } else if (command === "start-eye-tracking") {
    // Inject webgazer.js
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["webgazer.min.js"]
    });
    
    // Inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    
    chrome.tabs.sendMessage(tab.id, {
      type: "START_EYE_TRACKING",
      payload: { showVideo: false, showPredictions: true }
    });
  } else if (command === "stop-eye-tracking") {
    chrome.tabs.sendMessage(tab.id, { type: "STOP_EYE_TRACKING" });
  } else if (command === "calibrate-eye-tracking") {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["webgazer.min.js"]
    });
    
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    
    chrome.tabs.sendMessage(tab.id, { type: "CALIBRATE_EYE_TRACKING" });
  }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EYE_TRACKING_DATA") {
    // Handle eye tracking data from content script
    console.log("Eye tracking data:", message.payload);
    
    // You can store this data, send it to a server, or process it further
    // For example, you could store gaze data in chrome.storage
    chrome.storage.local.set({
      [`gaze_data_${Date.now()}`]: {
        x: message.payload.x,
        y: message.payload.y,
        timestamp: message.payload.timestamp,
        tabId: sender.tab?.id
      }
    });
    
    sendResponse({ success: true });
  } else if (message.type === "EYE_TRACKING_ERROR") {
    console.error("Eye tracking error:", message.payload);
    sendResponse({ success: false });
  } else if (message.type === "CALIBRATION_COMPLETE") {
    console.log("Eye tracking calibration completed");
    
    // Optionally store calibration data
    chrome.storage.local.set({
      calibration_complete: true,
      calibration_timestamp: Date.now()
    });
    
    sendResponse({ success: true });
  }
});

// Optional: Clean up old gaze data periodically
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cleanup_gaze_data") {
    chrome.storage.local.get(null, (items) => {
      const now = Date.now();
      const keysToRemove = [];
      
      for (const key in items) {
        if (key.startsWith("gaze_data_")) {
          const timestamp = parseInt(key.split("_")[2]);
          // Remove data older than 1 hour
          if (now - timestamp > 3600000) {
            keysToRemove.push(key);
          }
        }
      }
      
      if (keysToRemove.length > 0) {
        chrome.storage.local.remove(keysToRemove);
        console.log(`Cleaned up ${keysToRemove.length} old gaze data entries`);
      }
    });
  }
});

// Set up periodic cleanup alarm
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("cleanup_gaze_data", { periodInMinutes: 60 });
});

// Handle tab updates to potentially restart eye tracking
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    // Check if eye tracking was active on this tab
    chrome.storage.local.get([`eye_tracking_active_${tabId}`], (result) => {
      if (result[`eye_tracking_active_${tabId}`]) {
        // Optionally restart eye tracking after page reload
        console.log(`Page reloaded on tab ${tabId}, eye tracking was active`);
      }
    });
  }
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove([`eye_tracking_active_${tabId}`]);
});