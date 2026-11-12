const STORAGE_KEY = "bonsaiCaptures";
const $ = (id) => document.getElementById(id);

let currentFilter = "all";

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.round((now - d.getTime()) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return diffMin + "m ago";
  if (diffMin < 1440) return Math.round(diffMin / 60) + "h ago";
  return d.toLocaleDateString();
}

function renderRow(cap, tpl) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.postId = cap.postId || "";
  node.querySelector(".row__name").textContent = cap.authorName || "(unknown)";
  node.querySelector(".row__handle").textContent = cap.authorHandle || "";
  node.querySelector(".row__time").textContent = fmtTime(cap.capturedAt);
  node.querySelector(".row__text").textContent = cap.content || "(no text)";
  const media = node.querySelector(".row__media");
  if (cap.hasMedia) {
    media.textContent = (cap.mediaTypes || []).join(" · ");
  }
  const decision = node.querySelector(".row__decision");
  decision.textContent = cap.decision || "pending";
  decision.dataset.state = cap.decision || "pending";
  const link = node.querySelector(".row__link");
  if (cap.permalink) {
    link.href = cap.permalink;
  } else {
    link.remove();
  }
  return node;
}

async function render() {
  const { [STORAGE_KEY]: captures = [] } = await chrome.storage.local.get(STORAGE_KEY);

  const total = captures.length;
  const yes = captures.filter((c) => c.decision === "yes").length;
  const no = captures.filter((c) => c.decision === "no").length;
  const pending = total - yes - no;

  $("statTotal").textContent = total;
  $("statYes").textContent = yes;
  $("statNo").textContent = no;
  $("statPending").textContent = pending;

  const list = $("list");
  list.innerHTML = "";

  const filtered = captures.filter((c) => {
    if (currentFilter === "all") return true;
    if (currentFilter === "pending") return !c.decision;
    return c.decision === currentFilter;
  });

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      total === 0
        ? "No captures yet. Open x.com and scroll."
        : "Nothing matches this filter.";
    list.appendChild(empty);
    return;
  }

  const tpl = document.getElementById("row-tpl");
  for (const cap of filtered) {
    list.appendChild(renderRow(cap, tpl));
  }
}

async function clearAll() {
  if (!confirm("Clear all local captures? This can't be undone.")) return;
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  render();
}

async function sync() {
  const btn = $("syncBtn");
  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = "Syncing…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "bonsai:syncAll" });
    if (result && result.ok) {
      btn.textContent = `Synced ${result.sent}`;
    } else {
      btn.textContent = result?.error ? "Error" : "No-op";
      if (result?.error) console.error("sync error:", result.error);
    }
  } catch (e) {
    btn.textContent = "Error";
    console.error(e);
  } finally {
    setTimeout(() => {
      btn.textContent = origLabel;
      btn.disabled = false;
    }, 1600);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const manifest = chrome.runtime.getManifest();
  $("verLabel").textContent = "v" + manifest.version;

  document.querySelectorAll('input[name="f"]').forEach((r) => {
    r.addEventListener("change", (e) => {
      currentFilter = e.target.value;
      render();
    });
  });
  $("clearBtn").addEventListener("click", clearAll);
  $("syncBtn").addEventListener("click", sync);

  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) render();
});
