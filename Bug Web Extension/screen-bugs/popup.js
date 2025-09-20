const $ = (id) => document.getElementById(id);

async function withActiveTab(fn) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  return fn(tab);
}

$("release").addEventListener("click", async () => {
  const count = Number($("count").value) || 12;
  const size = Number($("size").value) || 48;
  const animate = $("animate").checked;

  await withActiveTab(async (tab) => {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    chrome.tabs.sendMessage(tab.id, {
      type: "INJECT_BUGS",
      payload: { count, size, animate }
    });
  });
});

$("releaseBeetle").addEventListener("click", async () => {
  const speed = Number($("beetleSpeed").value) || 180; // pixels/sec nominal
  const maxBall = Number($("maxBall").value) || 160;   // px diameter cap

  await withActiveTab(async (tab) => {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    chrome.tabs.sendMessage(tab.id, {
      type: "DUNG_BEETLE",
      payload: { speed, maxBall }
    });
  });
});

$("clear").addEventListener("click", async () => {
  await withActiveTab(async (tab) => {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    chrome.tabs.sendMessage(tab.id, { type: "CLEAR_BUGS" });
  });
});
