/* public/client.js
 * Minimal SPA chat UI (login → chat list → chat detail)
 * - Shows your message immediately
 * - Typing indicator while waiting
 * - Incremental append (no full re-render flicker)
 * - Lightweight Markdown + JSON-to-HTML rendering
 */

// ---------- CONFIG ----------
const API_BASE = ""; // same-origin

// Your existing Firebase web config:
const firebaseConfig = {
  apiKey: "AIzaSyBfXlv6cnFWop3qLKXLPSAdR0L0MlPIH5Y",
  authDomain: "project1-e7dff.firebaseapp.com",
  projectId: "project1-e7dff",
  storageBucket: "project1-e7dff.appspot.com",
  messagingSenderId: "208057685147",
  appId: "1:208057685147:web:5f13a84a8e8439c5d835e7"
};

// ---------- FIREBASE INIT ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ---------- UTIL ----------
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function html(strings, ...vals) {
  return strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ""), "");
}

function escapeHtml(s = "") {
  return (s + "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- ROUTER ----------
window.addEventListener("hashchange", render);
document.addEventListener("DOMContentLoaded", render);

async function render() {
  const hash = location.hash || "#/chat";
  if (hash.startsWith("#/login")) return renderLogin();

  // guard: need auth for chat
  if (!auth.currentUser) return renderLogin();

  if (hash === "#/chat") return renderChatList();
  if (hash.startsWith("#/chat/")) {
    const id = hash.split("/")[2];
    return renderChatDetail(id);
  }
  return renderChatList();
}

// ---------- LOGIN ----------
async function renderLogin() {
  $("app").innerHTML = `
    <section class="login-wrap">
      <div class="card login-card">
        <h1>Sign in</h1>
        <form id="login-form" class="stack">
          <label>Email</label>
          <input id="email" class="input" type="email" required />
          <label>Password</label>
          <input id="password" class="input" type="password" required />
          <div class="row">
            <button id="btn-login" class="btn btn-primary" type="submit">Sign in</button>
            <button id="btn-signup" class="btn btn-accent" type="button">Create account</button>
          </div>
        </form>
      </div>
    </section>
  `;

  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, $("email").value, $("password").value);
      location.hash = "#/chat";
    } catch (err) {
      alert(err.message || "Login failed");
    }
  };
  $("btn-signup").onclick = async () => {
    try {
      await createUserWithEmailAndPassword(auth, $("email").value, $("password").value);
      location.hash = "#/chat";
    } catch (err) {
      alert(err.message || "Signup failed");
    }
  };
}

onAuthStateChanged(auth, (u) => {
  if (!u) location.hash = "#/login";
});

// ---------- CHAT LIST ----------
async function renderChatList() {
  $("app").innerHTML = `
    <section class="chat-list">
      <div class="list-head">
        <h1>Chats</h1>
        <div class="spacer"></div>
        <button class="btn btn-ghost" id="btn-new">New Chat</button>
        <button class="btn btn-ghost" id="btn-logout">Sign out</button>
      </div>
      <div id="list" class="list"></div>
    </section>
  `;

  $("btn-logout").onclick = async () => {
    await signOut(auth);
    location.hash = "#/login";
  };

  $("btn-new").onclick = async () => {
    const headers = await authHeader();
    const r = await fetch(`${API_BASE}/api/sessions`, {
      method: "POST",
      headers
    });
    if (!r.ok) return alert("Failed to create chat");
    const { id } = await r.json();
    location.hash = `#/chat/${id}`;
  };

  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/sessions`, { headers });
  if (!r.ok) return;

  const items = await r.json();
  const listEl = $("list");
  listEl.innerHTML = items.map(it => {
    const title = it.title || "(untitled)";
    const date = new Date(it.updated_at || it.created_at || Date.now()).toLocaleString();
    return `
      <a class="list-item" href="#/chat/${it.id}">
        <div class="title">${escapeHtml(title)}</div>
        <div class="meta">${escapeHtml(date)}</div>
      </a>
    `;
  }).join("");
}

// ---------- CHAT DETAIL ----------
async function renderChatDetail(id) {
  // Build the view
  $("app").innerHTML = `
    <section class="chat">
      <div class="chat-head">
        <a class="link-back" href="#/chat">← All Chats</a>
        <div class="chat-title" id="chat-title"></div>
      </div>

      <div class="messages" id="messages"></div>

      <form class="composer" id="msg-form">
        <input id="msg" class="input" placeholder="Type your message…" autocomplete="off" />
        <button class="btn btn-primary" id="send-btn" type="submit">Send</button>
      </form>
    </section>
  `;

  const listEl = $("messages");
  // Single renderer used everywhere; maps role → classes you have in CSS
  const md = (txt) => {
    if (typeof window.renderMarkdown === "function") return window.renderMarkdown(txt || "");
    try {
      if (window.marked && window.DOMPurify) {
        return window.DOMPurify.sanitize(window.marked.parse(txt || ""));
      }
    } catch {}
    return (txt || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  };
  const renderOne = (m) => {
    const wrap = document.createElement("div");
    wrap.className = `msg ${m.role === "assistant" ? "assistant" : "you"}`;
    wrap.innerHTML = `
      <div class="who">${m.role === "assistant" ? "🤖" : "You"}</div>
      <div class="md">${md(m.content || "")}</div>
    `;
    listEl.appendChild(wrap);
  };

  let isWaiting = false;

  const showTyping = () => {
    const existing = document.getElementById("typing-bubble");
    if (existing) return existing.id;
    const el = document.createElement("div");
    el.id = "typing-bubble";
    el.className = "msg assistant typing";
    el.innerHTML = `
      <div class="who">🤖</div>
      <div class="md">
        <span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
      </div>
    `;
    listEl.appendChild(el);
    listEl.scrollTop = listEl.scrollHeight;
    return el.id;
  };
  const hideTyping = (id) => {
    const el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  };

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
    for (const m of msgs) renderOne(m);

    // Title = first user line if present
    const firstUser = msgs.find(m => m.role === "user" && (m.content || "").trim());
    if (firstUser) $("chat-title").textContent = (firstUser.content || "").slice(0, 64);
    listEl.scrollTop = listEl.scrollHeight;
  }

  // Initial load
  await loadThread();

  // Send
  $("msg-form").onsubmit = async (e) => {
    e.preventDefault();
    if (isWaiting) return;
    const input = $("msg");
    const sendBtn = $("send-btn");
    const content = (input.value || "").trim();
    if (!content) return;

    // Optimistic user message
    renderOne({ role: "user", content });
    listEl.scrollTop = listEl.scrollHeight;
    input.value = "";

    // Enter waiting + show typing
    isWaiting = true;
    if (sendBtn) sendBtn.disabled = true;
    input.disabled = true;
    const typingId = showTyping();

    try {
      const headers = { "Content-Type": "application/json", ...(await authHeader()) };
      const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content })
      });

      // If the POST failed, stop waiting and show an error
      if (!r.ok) {
        hideTyping(typingId);
        isWaiting = false;
        if (sendBtn) sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
        console.error("Send message failed", r.status);
        if (r.status === 401 || r.status === 403) location.hash = "#/login";
        renderOne({ role: "assistant", content: "Sorry—couldn't send that. Try again." });
        listEl.scrollTop = listEl.scrollHeight;
        return;
      }

      // Keep the typing bubble visible and poll until an assistant reply arrives
      let gotAssistant = false;
      for (let i = 0; i < 60; i++) { // ~60s max
        await loadThread();
        const lastMsg = listEl.lastElementChild;
        if (lastMsg && lastMsg.classList.contains("assistant")) {
          gotAssistant = true;
          break;
        }
        await new Promise(res => setTimeout(res, 1000));
      }
      hideTyping(typingId);
      isWaiting = false;
      if (sendBtn) sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
      if (!gotAssistant) {
        // Fallback: ensure the latest thread is shown
        await loadThread();
      }
      listEl.scrollTop = listEl.scrollHeight;
    } catch (err) {
      hideTyping(typingId);
      isWaiting = false;
      if (sendBtn) sendBtn.disabled = false;
      input.disabled = false;
      console.error("Send error:", err);
      renderOne({ role: "assistant", content: "Network hiccup—please try again." });
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
