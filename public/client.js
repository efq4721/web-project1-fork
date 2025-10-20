/* public/client.js
 * Minimal SPA chat UI (login → chat list → chat detail)
 * - Shows your message immediately
 * - Typing indicator while waiting (… bubble stays until reply lands)
 * - Incremental append (no full re-render flicker)
 * - Lightweight Markdown + JSON-to-HTML rendering
 */

// ---------- CONFIG ----------
const API_BASE = ""; // same-origin

// Your existing Firebase web config:
const firebaseConfig = {
  apiKey: "AIzaSyBfXlv6cnFWop3qLKXLPSAdR0L0MlPIH5Y",
  authDomain: "project1-e7dff.firebaseapp.com",
  databaseURL: "https://project1-e7dff-default-rtdb.firebaseio.com",
  projectId: "project1-e7dff",
  storageBucket: "project1-e7dff.firebasestorage.app",
  messagingSenderId: "41147317681",
  appId: "1:41147317681:web:34210bd0233408056a5190",
  measurementId: "G-24ZM1BZGM5"
};

// ---------- FIREBASE (CDN) ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const appFB = initializeApp(firebaseConfig);
const auth = getAuth(appFB);

// ---------- DOM UTILS ----------
const $ = (id) => document.getElementById(id);
const tpl = (id) => document.getElementById(id)?.innerHTML ?? "";

function escapeHtml(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
const roleClass = (role) => (role === "assistant" ? "assistant" : "you");
const whoText  = (role) => (role === "assistant" ? "🤖" : "You");

// Basic Markdown → HTML (bold/italic, lists, code, paragraphs)
function mdToHtml(text) {
  if (!text) return "";
  let t = String(text).replace(/\r\n/g, "\n");

  // fenced code blocks ``` ```
  t = t.replace(/```([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${escapeHtml(code)}</code></pre>`);

  // inline code `code`
  t = t.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);

  // bold **text**
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

  // italic *text*
  t = t.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");

  // simple lists: lines starting with - or *
  const lines = t.split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${escapeHtml(m[1])}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line.trim() === "") html += "<br>";
      else html += `<p>${escapeHtml(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

// If the model responds with a JSON object, format nicely; fallback to pretty JSON or markdown.
function jsonToHtml(jsonStr) {
  try {
    const obj = JSON.parse(jsonStr);
    const parts = [];

    if (obj.title) parts.push(`<h3>${escapeHtml(obj.title)}</h3>`);
    if (obj.explanation) parts.push(`<p>${escapeHtml(obj.explanation)}</p>`);

    const pushList = (label, arr) => {
      if (!Array.isArray(arr) || !arr.length) return;
      if (label) parts.push(`<h4>${escapeHtml(label)}</h4>`);
      parts.push("<ul>");
      for (const it of arr) {
        if (typeof it === "string") parts.push(`<li>${escapeHtml(it)}</li>`);
        else if (it && typeof it === "object" && it.step) parts.push(`<li>${escapeHtml(it.step)}</li>`);
        else parts.push(`<li>${escapeHtml(String(it))}</li>`);
      }
      parts.push("</ul>");
    };

    if (obj.what_it_is) parts.push(`<p><b>What it is:</b> ${escapeHtml(obj.what_it_is)}</p>`);
    pushList("Why it matters", obj.why_it_matters);
    pushList("How it works", obj.how_it_works_generally);
    pushList("Common types", obj.common_tech_types_by_game);
    if (obj.training_tip) parts.push(`<p><b>Training tip:</b> ${escapeHtml(obj.training_tip)}</p>`);

    if (!parts.length) {
      return `<pre><code>${escapeHtml(JSON.stringify(obj, null, 2))}</code></pre>`;
    }
    return parts.join("\n");
  } catch {
    return ""; // not valid JSON
  }
}

// Render one message bubble (no page re-render)
function renderMessage(container, msg) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${msg.role === "assistant" ? "assistant" : "you"}`;
  wrap.dataset.id = msg.id || "";

  const whoEl = document.createElement("div");
  whoEl.className = "who";
  whoEl.textContent = (msg.role === "assistant" ? "🤖" : "You");

  const body = document.createElement("div");
  body.className = "md"; // IMPORTANT: match styles.css

  const raw = (msg.content ?? "").toString();
  // Prefer the global renderer you defined in index.html
  if (typeof window.renderMarkdown === "function") {
    body.innerHTML = window.renderMarkdown(raw);
  } else {
    // fallback: very light markdown
    const html = mdToHtml(raw);
    body.innerHTML = html || escapeHtml(raw);
  }

  wrap.appendChild(whoEl);
  wrap.appendChild(body);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}


// Single typing bubble (uses .dots/.dot — matches your CSS)
function showTyping(container) {
  let el = container.querySelector("#typing-bubble");
  if (el) return el; // already showing
  el = document.createElement("div");
  el.id = "typing-bubble";
  el.className = "msg assistant typing";
  el.innerHTML = `
    <div class="who">🤖</div>
    <div class="md">
      <span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
    </div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}
function hideTyping(container) {
  const el = container.querySelector("#typing-bubble");
  if (el) el.remove();
}

// ---------- ROUTER ----------
window.addEventListener("hashchange", route);

onAuthStateChanged(auth, () => route());
getRedirectResult(auth).catch(e => console.log("redirect sign-in error:", e));

function route() {
  const [_, page, id] = (location.hash || "#/login").split("/");

  if (page === "login") {
    if (auth.currentUser) {
      location.hash = "#/chat";
      return;
    }
    return renderLogin();
  }

  if (!auth.currentUser) {
    location.hash = "#/login";
    return;
  }

  if (page === "chat" && !id) return renderChatList();
  if (page === "chat" && id)  return renderChatDetail(id);

  location.hash = "#/login";
}

// ---------- VIEWS ----------
async function renderLogin() {
  $("app").innerHTML = tpl("tpl-login");

  $("btn-google").onclick = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      location.hash = "#/chat";
    } catch (e) {
      console.log("Popup blocked, falling back to redirect:", e);
      await signInWithRedirect(auth, new GoogleAuthProvider());
    }
  };
}

async function renderChatList() {
  $("app").innerHTML = tpl("tpl-chat");

  $("btn-logout").onclick = () => signOut(auth);
  $("btn-new").onclick = async () => {
    const headers = { "Content-Type": "application/json", ...(await authHeader()) };
    const r = await fetch(`${API_BASE}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ title: "New chat" }) });
    if (!r.ok) {
      console.error("Create session failed", r.status);
      if (r.status === 401 || r.status === 403) location.hash = "#/login";
      return;
    }
    const j = await r.json();
    location.hash = `#/chat/${j.id}`;
  };

  // load sessions
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/sessions`, { headers });
  if (!r.ok) {
    console.error("List sessions failed", r.status);
    if (r.status === 401 || r.status === 403) location.hash = "#/login";
    return;
  }
  const sessions = await r.json();
  $("session-list").innerHTML = sessions.map(s => {
  const when = new Date(s.updatedAt || s.createdAt || Date.now()).toLocaleString();
  const title = s.title || "New chat";
  return `
    <li class="session-row" data-id="${s.id}">
      <a class="title" href="#/chat/${s.id}">${escapeHtml(title)}</a>
      <small class="muted">${when}</small>
      <div class="row-actions">
        <button class="icon-btn rename" title="Rename" data-id="${s.id}">Rename</button>
        <button class="icon-btn danger delete" title="Delete" data-id="${s.id}">Delete</button>
      </div>
    </li>`;
}).join("");

// Event delegation for rename/delete
$("session-list").onclick = async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const sid = btn.dataset.id;
  if (!sid) return;

  if (btn.classList.contains("rename")) {
    const current = btn.closest("li")?.querySelector(".title")?.textContent?.trim() || "";
    const name = prompt("Rename chat:", current);
    if (name == null) return; // cancelled
    const newTitle = name.trim();
    if (!newTitle) return alert("Title cannot be empty.");
    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) };
      const r = await fetch(`${API_BASE}/api/sessions/${sid}`, {
        method: "PATCH", headers, body: JSON.stringify({ title: newTitle })
      });
      if (!r.ok) throw new Error(`Rename failed: ${r.status}`);
      // Refresh list
      const hdrs = await authHeader();
      const rr = await fetch(`${API_BASE}/api/sessions`, { headers: hdrs });
      const sessions2 = await rr.json();
      $("session-list").innerHTML = sessions2.map(s => {
        const when = new Date(s.updatedAt || s.createdAt || Date.now()).toLocaleString();
        const title = s.title || "New chat";
        return `
          <li class="session-row" data-id="${s.id}">
            <a class="title" href="#/chat/${s.id}">${escapeHtml(title)}</a>
            <small class="muted">${when}</small>
            <div class="row-actions">
              <button class="icon-btn rename" title="Rename" data-id="${s.id}">Rename</button>
              <button class="icon-btn danger delete" title="Delete" data-id="${s.id}">Delete</button>
            </div>
          </li>`;
      }).join("");
    } catch (err) {
      console.error(err);
      alert("Could not rename chat.");
    }
  }

  if (btn.classList.contains("delete")) {
    if (!confirm("Delete this chat? This cannot be undone.")) return;
    try {
      const headers = await authHeader();
      const r = await fetch(`${API_BASE}/api/sessions/${sid}`, { method: "DELETE", headers });
      if (!r.ok) throw new Error(`Delete failed: ${r.status}`);
      // Remove the row locally
      btn.closest("li")?.remove();
    } catch (err) {
      console.error(err);
      alert("Could not delete chat.");
    }
  }
};

}

async function renderChatDetail(id) {
  // Build the view (inline template)
  $("app").innerHTML = `
    <section class="chat">
      <div class="chat-head">
        <a class="link-back" href="#/chat">← All Chats</a>
        <div class="chat-title-wrap">
          <div class="chat-title" id="chat-title"></div>
          <div class="row-actions head-actions">
            <button class="icon-btn rename-chat" id="btn-rename-chat" title="Rename">Rename</button>
            <button class="icon-btn danger delete-chat" id="btn-delete-chat" title="Delete">Delete</button>
          </div>
        </div>
      </div>

      <div class="messages" id="messages"></div>

      <form class="composer" id="msg-form">
        <input id="msg" class="input" placeholder="Type your message…" autocomplete="off" />
        <button class="btn btn-primary" id="send-btn" type="submit">Send</button>
      </form>
    </section>
  `;

  const listEl = $("messages");
  let isWaiting = false;

  // Load + paint messages for this session
  async function loadThread() {
    const headers = await authHeader();
    const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, { headers });
    if (!r.ok) {
      console.error("Load messages failed", r.status);
      if (r.status === 401 || r.status === 403) location.hash = "#/login";
      return;
    }
    const msgs = await r.json();

    listEl.innerHTML = "";
    for (const m of msgs) renderMessage(listEl, m);

    // Title = first user line if present
    const firstUser = msgs.find(m => m.role === "user" && (m.content || "").trim());
    if (firstUser) $("chat-title").textContent = (firstUser.content || "").slice(0, 60);

    listEl.scrollTop = listEl.scrollHeight;
  }

  // Initial load
  await loadThread();

  // Submit handler: optimistic user bubble + typing + send + poll until assistant reply
  $("msg-form").onsubmit = async (e) => {
    e.preventDefault();
    if (isWaiting) return;

    const input = $("msg");
    const sendBtn = $("send-btn");
    const content = (input.value || "").trim();
    if (!content) return;

    // Optimistic user message
    renderMessage(listEl, { role: "user", content });
    listEl.scrollTop = listEl.scrollHeight;
    input.value = "";

    // Enter waiting state and show typing bubble
    isWaiting = true;
    if (sendBtn) sendBtn.disabled = true;
    input.disabled = true;
    showTyping(listEl);

    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) };
      const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, {
        method: "POST", headers, body: JSON.stringify({ content })
      });

      if (!r.ok) {
        hideTyping(listEl);
        isWaiting = false;
        if (sendBtn) sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
        console.error("Send message failed", r.status);
        if (r.status === 401 || r.status === 403) location.hash = "#/login";
        renderMessage(listEl, { role: "assistant", content: "Sorry—couldn't send that. Try again." });
        listEl.scrollTop = listEl.scrollHeight;
        return;
      }

      // Keep the typing bubble and poll for the assistant reply (up to ~60s)
      let gotAssistant = false;
      for (let i = 0; i < 60; i++) {
        await loadThread();
        const last = listEl.lastElementChild;
        if (last && last.classList.contains("assistant")) { gotAssistant = true; break; }
        await new Promise(res => setTimeout(res, 1000));
      }

      hideTyping(listEl);
      isWaiting = false;
      if (sendBtn) sendBtn.disabled = false;
      input.disabled = false;
      input.focus();

      // Final safety refresh if we somehow missed it
      if (!gotAssistant) await loadThread();
      listEl.scrollTop = listEl.scrollHeight;
    } catch (err) {
      hideTyping(listEl);
      isWaiting = false;
      if (sendBtn) sendBtn.disabled = false;
      input.disabled = false;
      console.error("Send error:", err);
      renderMessage(listEl, { role: "assistant", content: "Network hiccup—please try again." });
      listEl.scrollTop = listEl.scrollHeight;
    }
  };
}

// ---------- AUTH HEADER ----------
async function authHeader() {
  const u = auth.currentUser;
  const t = u ? await u.getIdToken() : null;
  return t ? { Authorization: `Bearer ${t}` } : {};
}
