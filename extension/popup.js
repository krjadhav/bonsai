const $ = (id) => document.getElementById(id);

async function refreshAuthUI() {
  const { bonsaiUser } = await chrome.storage.local.get("bonsaiUser");
  const signedIn = Boolean(bonsaiUser && bonsaiUser.email);
  $("signedOut").hidden = signedIn;
  $("signedIn").hidden = !signedIn;
  if (signedIn) {
    $("userName").textContent = bonsaiUser.name || "Signed in";
    $("userEmail").textContent = bonsaiUser.email;
    if (bonsaiUser.picture) $("avatar").src = bonsaiUser.picture;
  }
}

async function signIn() {
  $("signInBtn").disabled = true;
  try {
    const user = await chrome.runtime.sendMessage({ type: "bonsai:signIn" });
    if (user && user.email) {
      await chrome.storage.local.set({ bonsaiUser: user });
    } else if (user && user.error) {
      alert("Sign-in failed: " + user.error);
    }
  } finally {
    $("signInBtn").disabled = false;
    refreshAuthUI();
  }
}

async function signOut() {
  await chrome.runtime.sendMessage({ type: "bonsai:signOut" });
  await chrome.storage.local.remove("bonsaiUser");
  refreshAuthUI();
}

async function openSidebar() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && chrome.sidePanel && chrome.sidePanel.open) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (e) {
      console.warn("sidePanel.open failed", e);
    }
  }
  window.close();
}

document.addEventListener("DOMContentLoaded", () => {
  const manifest = chrome.runtime.getManifest();
  $("verLabel").textContent = "v" + manifest.version;

  $("signInBtn").addEventListener("click", signIn);
  $("signOutBtn").addEventListener("click", signOut);
  $("openSidebarBtn").addEventListener("click", openSidebar);

  refreshAuthUI();
});
