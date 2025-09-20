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
    // (ADD) helper if you don't already have one
  async function __sendToActiveTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, message);
  }

  // (ADD) termites button
  document.getElementById('releaseTermitesBtn')?.addEventListener('click', async () => {
    const count = parseInt(document.getElementById('termiteCount')?.value || '20', 10);
    const size  = parseInt(document.getElementById('termiteSize')?.value  || '10', 10);
    await __sendToActiveTab({ type: 'RELEASE_TERMITES', payload: { count, size } });
  });

document.getElementById('releaseSpidersBtn')?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const count = 1; // or read from an input
  chrome.tabs.sendMessage(tab.id, { type: 'RELEASE_SPIDERS', payload: { count, size: 42 } });
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
