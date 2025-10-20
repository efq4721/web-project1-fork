// public/client.js — Firebase auth, router, chat UI (optimistic + typing bubble)

// ---------- CONFIG ----------
const API_BASE = ""; // same origin

// Your Firebase web config (keep yours here)
const firebaseConfig = {
  apiKey: "AIzaSyBfXlv6cnFWop3qLKXLPSAdR0L0MlPIH5Y",
  authDomain: "project1-e7dff.firebaseapp.com",
  databaseURL: "https://project1-e7dff-default-rtdb.firebaseio.com",
  projectId: "project1-e7dff",
  storageBucket: "project1-e7dff.firebasestorage.app",
  messagingSenderId: "41147317681",
  appId: "1:41147317681:web:34210bd0233408056a5190",
  measurementId: "G-24ZM1BZGM5",
};

// ---------- FIREBASE (CDN) ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ---------- UTILS ----------
const $   = (id)=>document.getElementById(id);
const el  = (html)=>{ const d=document.createElement("div"); d.innerHTML=html.trim(); return d.firstElementChild; };
async function authHeader(){
  const u = auth.currentUser;
  const t = u ? await u.getIdToken() : null;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// VERY small markdown-to-HTML (bold, code, lists, paragraphs). Safe enough for our text.
window.renderMarkdown = function renderMarkdown(src=""){
  let s = String(src ?? "");
  s = s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  // bold **x**
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // inline code `x`
  s = s.replace(/`([^`]+?)`/g, "<code>$1</code>");
  // bullets (lines starting with "* " or "- ")
  if (/^(?:\*|-)\s+/m.test(s)) {
    s = s.split(/\n{2,}/).map(block=>{
      if (/^(?:\*|-)\s+/m.test(block)) {
        const items = block.split(/\n/).map(l=>l.replace(/^(?:\*|-)\s+/, "").trim()).filter(Boolean);
        return `<ul>${items.map(li=>`<li>${li}</li>`).join("")}</ul>`;
      }
      return `<p>${block.replace(/\n/g,"<br>")}</p>`;
    }).join("\n");
  } else {
    s = s.split(/\n{2,}/).map(p=>`<p>${p.replace(/\n/g,"<br>")}</p>`).join("\n");
  }
  return s;
};

// ---------- ROUTER ----------
window.addEventListener('hashchange', route);
onAuthStateChanged(auth, (u) => { route(); });
getRedirectResult(auth).catch(e => console.log('redirect sign-in error:', e));

function route(){
  const [_, page, id] = (location.hash || '#/login').split('/');

  if (page === 'login') {
    if (auth.currentUser) { location.hash = '#/chat'; return; }
    return renderLogin();
  }

  if (!auth.currentUser) { location.hash = '#/login'; return; }

  if (page === 'chat' && !id) return renderChatList();
  if (page === 'chat' && id)  return renderChatDetail(id);

  location.hash = '#/login';
}

// ---------- VIEWS ----------
function renderLogin(){
  document.body.innerHTML = `
    <main class="login-wrap">
      <section class="glass login-card">
        <div class="brand"><strong>FGC</strong><span style="color:#7c3aed">Chat</span></div>
        <button id="btn-google" class="btn btn-primary" style="width:100%">Sign in with Google</button>
      </section>
    </main>
  `;
  $('btn-google').onclick = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      await signInWithRedirect(auth, new GoogleAuthProvider());
    }
  };
}

async function renderChatList(){
  document.body.innerHTML = `
    <main class="app">
      <div class="layout">
        <aside class="sidebar">
          <div class="sidebar-head">
            <div class="logo">FGC<span>Chat</span></div>
            <button id="btn-logout" class="btn btn-ghost">Log out</button>
          </div>
          <div class="sidebar-actions">
            <button id="btn-new" class="btn btn-accent">+ New Chat</button>
          </div>
          <ul id="session-list" class="session-list"></ul>
        </aside>
        <section class="chat">
          <div class="messages" id="messages">
            <div class="empty-state">
              <div class="glass empty-card">
                <h1>Welcome 👋</h1>
                <p class="muted">Create a chat on the left to get started.</p>
              </div>
            </div>
          </div>
          <form class="composer" id="msg-form" style="display:none">
            <input id="msg" class="input" placeholder="Type your message…" autocomplete="off" />
            <button class="btn btn-primary" id="send-btn" type="submit">Send</button>
          </form>
        </section>
      </div>
    </main>
  `;

  $('btn-logout').onclick = () => signOut(auth);
  $('btn-new').onclick = async ()=>{
    const headers = { 'Content-Type':'application/json', ...(await authHeader()) };
    const r = await fetch(`${API_BASE}/api/sessions`, { method:'POST', headers, body: JSON.stringify({ title:'New chat' }) });
    if (!r.ok) { if (r.status === 401 || r.status === 403) location.hash = '#/login'; return; }
    const j = await r.json();
    location.hash = `#/chat/${j.id}`;
  };

  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/sessions`, { headers });
  if (!r.ok) { if (r.status === 401 || r.status === 403) location.hash = '#/login'; return; }
  const sessions = await r.json();

  $('session-list').innerHTML =
    sessions.map(s=>{
      const when = new Date(s.updatedAt || s.createdAt || Date.now()).toLocaleString();
      return `<li><a href="#/chat/${s.id}">${(s.title||'New chat')}</a><br><small class="muted">${when}</small></li>`;
    }).join('');
}

async function renderChatDetail(id){
  document.body.innerHTML = `
    <main class="app">
      <div class="layout">
        <aside class="sidebar">
          <div class="sidebar-head">
            <div class="logo">FGC<span>Chat</span></div>
            <button id="btn-logout" class="btn btn-ghost">Log out</button>
          </div>
          <div class="sidebar-actions">
            <a class="btn btn-accent" href="#/chat">← All Chats</a>
          </div>
          <ul id="session-list" class="session-list"></ul>
        </aside>

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
      </div>
    </main>
  `;

  $('btn-logout').onclick = () => signOut(auth);

  const listEl = $('messages');

  const md = (txt)=> window.renderMarkdown(txt || "");

  const renderOne = (m) => {
    const node = el(`
      <div class="msg ${m.role === 'assistant' ? 'assistant' : 'you'}">
        <div class="who">${m.role === 'assistant' ? '🤖' : 'You'}</div>
        <div class="md">${md(m.content || '')}</div>
      </div>
    `);
    listEl.appendChild(node);
    return node;
  };

  const showTyping = () => {
    const node = el(`
      <div id="typing-bubble" class="msg assistant typing">
        <div class="who">🤖</div>
        <div class="md"><span class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>
      </div>
    `);
    listEl.appendChild(node);
    return node;
  };

  const hideTyping = () => {
    const t = $('typing-bubble');
    if (t && t.parentNode) t.parentNode.removeChild(t);
  };

  const scrollToBottom = () => { listEl.scrollTop = listEl.scrollHeight; };

  async function loadThread(){
    const headers = await authHeader();
    const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, { headers });
    if (!r.ok) { if (r.status === 401 || r.status === 403) location.hash = '#/login'; return; }
    const msgs = await r.json();

    listEl.innerHTML = '';
    for (const m of msgs) renderOne(m);

    const firstUser = msgs.find(m => m.role === 'user' && (m.content || '').trim());
    if (firstUser) $('chat-title').textContent = (firstUser.content || '').slice(0, 80);

    // Also populate sidebar quickly
    try {
      const rs = await fetch(`${API_BASE}/api/sessions`, { headers });
      if (rs.ok) {
        const ss = await rs.json();
        $('session-list').innerHTML =
          ss.map(s=>{
            const when = new Date(s.updatedAt || s.createdAt || Date.now()).toLocaleString();
            return `<li><a href="#/chat/${s.id}">${(s.title||'New chat')}</a><br><small class="muted">${when}</small></li>`;
          }).join('');
      }
    } catch {}
    scrollToBottom();
  }

  await loadThread();

  $('msg-form').onsubmit = async (e)=>{
    e.preventDefault();
    const input = $('msg');
    const content = (input.value || '').trim();
    if (!content) return;

    // My message immediately
    renderOne({ role:'user', content });
    scrollToBottom();
    input.value = '';

    // Typing…
    showTyping();
    scrollToBottom();

    try {
      const headers = { 'Content-Type':'application/json', ...(await authHeader()) };
      const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, {
        method:'POST', headers, body: JSON.stringify({ content })
      });

      hideTyping();

      if (!r.ok) {
        renderOne({ role:'assistant', content: "Sorry—couldn't send that. Try again." });
        scrollToBottom();
        if (r.status === 401 || r.status === 403) location.hash = '#/login';
        return;
      }

      // Reload thread so we show the stored assistant message
      await loadThread();
    } catch (err) {
      hideTyping();
      renderOne({ role:'assistant', content: "Network hiccup—please try again." });
      scrollToBottom();
    }
  };
}
