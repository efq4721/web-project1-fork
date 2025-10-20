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
const tpl = (id) => document.getElementById(id).innerHTML;

function escapeHtml(s) {
  return (s ?? "").toString().replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function autoScroll(container) {
  container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
}

// Basic Markdown → HTML (bold/italic, lists, code, paragraphs)
function mdToHtml(text) {
  if (!text) return "";
  let t = text.replace(/\r\n/g, "\n");

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
      html += `<li>${m[1]}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line.trim() === "") html += "<br>";
      else html += `<p>${line}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

// If the model responds with a JSON object (like your “tech” example),
// format it nicely into HTML. Fallback to pretty JSON.
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

    // Common keys we saw
    if (obj.what_it_is) parts.push(`<p><b>What it is:</b> ${escapeHtml(obj.what_it_is)}</p>`);
    pushList("Why it matters", obj.why_it_matters);
    pushList("How it works", obj.how_it_works_generally);
    pushList("Common types", obj.common_tech_types_by_game);
    if (obj.training_tip) parts.push(`<p><b>Training tip:</b> ${escapeHtml(obj.training_tip)}</p>`);

    // If nothing matched, fallback to pretty JSON
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
  const who = msg.role === "assistant" ? "🤖" : "You";
  const wrap = document.createElement("div");
  wrap.className = `msg ${msg.role}`;
  wrap.dataset.id = msg.id || "";

  const whoEl = document.createElement("div");
  whoEl.className = "who";
  whoEl.textContent = who;

  const body = document.createElement("div");
  body.className = "msg-body";

  let html = "";
  const raw = (msg.content ?? "").toString();

  // Try JSON first if it looks like JSON
  if (raw.trim().startsWith("{") || raw.trim().startsWith("[")) {
    html = jsonToHtml(raw) || mdToHtml(raw);
  } else {
    html = mdToHtml(raw);
  }

  body.innerHTML = html || escapeHtml(raw);
  wrap.appendChild(whoEl);
  wrap.appendChild(body);
  container.appendChild(wrap);
}

// Typing indicator bubble
function addTyping(container) {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant typing-bubble";
  wrap.innerHTML = `
    <div class="who">🤖</div>
    <div class="msg-body">
      <span class="typing">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </span>
    </div>`;
  container.appendChild(wrap);
  return wrap;
}
function removeTyping(container) {
  const el = container.querySelector(".typing-bubble");
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
    return `<li><a href="#/chat/${s.id}">${escapeHtml(s.title || s.id)}</a> <small class="muted">${when}</small></li>`;
  }).join("");
}
function renderOneMessage(container, m){
  const div = document.createElement('div');
  div.className = `msg ${m.role === 'assistant' ? 'assistant' : 'you'}`;
  div.innerHTML = `
    <div class="who">${m.role === 'assistant' ? '🤖' : 'You'}</div>
    <div class="md">${(window.renderMarkdown ? renderMarkdown(m.content || '') : (m.content || '').replace(/</g,'&lt;'))}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function showTyping(container, id){
  const div = document.createElement('div');
  div.id = id;
  div.className = 'msg assistant typing';
  div.innerHTML = `
    <div class="who">🤖</div>
    <div class="md"><span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function hideTyping(id){
  const el = document.getElementById(id);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

async function renderChatDetail(id){
  // Build the view
  $('app').innerHTML = `
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

  // Small helpers for this view
  const listEl = $('messages');

  const md = (txt) => {
    // Prefer global markdown renderer if you added one; otherwise simple escape+br
    if (typeof window.renderMarkdown === 'function') return window.renderMarkdown(txt || '');
    return (txt || '').replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\n/g,"<br>");
  };

  const renderOne = (m) => {
    const wrap = document.createElement('div');
    wrap.className = `msg ${m.role === 'assistant' ? 'assistant' : 'you'}`;
    wrap.innerHTML = `
      <div class="who">${m.role === 'assistant' ? '🤖' : 'You'}</div>
      <div class="md">${md(m.content || '')}</div>
    `;
    listEl.appendChild(wrap);
  };

  const showTyping = () => {
    const el = document.createElement('div');
    el.id = 'typing-bubble';
    el.className = 'msg assistant typing';
    el.innerHTML = `
      <div class="who">🤖</div>
      <div class="md"><span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>
    `;
    listEl.appendChild(el);
    return el.id;
  };

  const hideTyping = (id) => {
    const el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  };

  const scrollToBottom = () => {
    listEl.scrollTop = listEl.scrollHeight;
  };

  // Load + paint messages for this session
  async function loadThread(){
    const headers = await authHeader();
    const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, { headers });
    if (!r.ok) {
      console.error('Load messages failed', r.status);
      if (r.status === 401 || r.status === 403) location.hash = '#/login';
      return;
    }
    const msgs = await r.json();

    listEl.innerHTML = '';
    for (const m of msgs) renderOne(m);

    // Title = first user line if present
    const firstUser = msgs.find(m => m.role === 'user' && (m.content || '').trim());
    if (firstUser) $('chat-title').textContent = (firstUser.content || '').slice(0, 60);
    scrollToBottom();
  }

  // Initial load
  await loadThread();

  // Submit handler: optimistic user bubble + typing + send + refresh
  $('msg-form').onsubmit = async (e)=>{
    e.preventDefault();
    const input = $('msg');
    const content = (input.value || '').trim();
    if (!content) return;

    // Optimistic user message
    renderOne({ role:'user', content });
    scrollToBottom();
    input.value = '';

    // Typing …
    const typingId = showTyping();
    scrollToBottom();

    // Send to server
    try {
      const headers = { 'Content-Type':'application/json', ...(await authHeader()) };
      const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, {
        method:'POST',
        headers,
        body: JSON.stringify({ content })
      });

      hideTyping(typingId);

      if (!r.ok) {
        console.error('Send message failed', r.status);
        if (r.status === 401 || r.status === 403) location.hash = '#/login';
        // Show an inline error bubble so the user sees something
        renderOne({ role:'assistant', content: "Sorry—couldn't send that. Try again." });
        scrollToBottom();
        return;
      }

      // Reload full thread so we render the assistant reply from DB
      await loadThread();
    } catch (err) {
      hideTyping(typingId);
      console.error('Send error:', err);
      renderOne({ role:'assistant', content: "Network hiccup—please try again." });
      scrollToBottom();
    }
  };
}

// ---------- AUTH HEADER ----------
async function authHeader() {
  const u = auth.currentUser;
  const t = u ? await u.getIdToken() : null;
  return t ? { Authorization: `Bearer ${t}` } : {};
}
