// ---------- CONFIG ----------
const API_BASE = ''; // same origin (Render serves /server/public)

// Your existing Firebase config
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ---------- UTILS ----------
const $   = (id)=>document.getElementById(id);
const tpl = (id)=>document.getElementById(id).innerHTML;

async function authHeader(){
  const u = auth.currentUser;
  const t = u ? await u.getIdToken() : null;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function escapeHtml(s){return (s||"").replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[c]));}

function mdToHtml(s){
  try { return DOMPurify.sanitize(marked.parse(s || "")); }
  catch { return (s || "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'}[c])); }
}
function scrollMessagesBottom(){
  const box = $('messages');
  if (box) box.scrollTop = box.scrollHeight;
}

// ---------- ROUTER ----------
window.addEventListener('hashchange', route);

onAuthStateChanged(auth, (u) => {
  console.log('auth state:', !!u, u?.uid || null);
  route();
});

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
  $('app').innerHTML = tpl('tpl-login');
  $('btn-google').onclick = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      console.log('Popup blocked, using redirect:', e);
      await signInWithRedirect(auth, new GoogleAuthProvider());
    }
  };
}

async function renderChatList(){
  $('app').innerHTML = tpl('tpl-chat');

  $('btn-logout').onclick = () => signOut(auth);
  $('btn-new').onclick = async ()=>{
    const headers = { 'Content-Type':'application/json', ...(await authHeader()) };
    const r = await fetch(`${API_BASE}/api/sessions`, { method:'POST', headers, body: JSON.stringify({ title:'New chat' }) });
    if (!r.ok) { if (r.status === 401 || r.status === 403) location.hash = '#/login'; return; }
    const j = await r.json();
    location.hash = `#/chat/${j.id}`;
  };

  await populateSidebarSessions();
}

async function renderChatDetail(id){
  $('app').innerHTML = tpl('tpl-chat-detail');

  $('btn-logout').onclick = () => signOut(auth);
  $('btn-new').onclick = async ()=>{
    const headers = { 'Content-Type':'application/json', ...(await authHeader()) };
    const r = await fetch(`${API_BASE}/api/sessions`, { method:'POST', headers, body: JSON.stringify({ title:'New chat' }) });
    if (!r.ok) { if (r.status === 401 || r.status === 403) location.hash = '#/login'; return; }
    const j = await r.json();
    location.hash = `#/chat/${j.id}`;
  };

  await populateSidebarSessions(id);
  await loadMessages(id);

  const form = $('msg-form');
  const input = $('msg');
  const sendBtn = $('btn-send');

  form.onsubmit = async (e)=>{
    e.preventDefault();
    const content = (input.value || '').trim();
    if(!content) return;

    input.value = '';
    input.disabled = true; sendBtn.disabled = true;

    const headers = { 'Content-Type':'application/json', ...(await authHeader()) };
    const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, {
      method:'POST', headers, body: JSON.stringify({ content })
    });

    input.disabled = false; sendBtn.disabled = false;
    input.focus();

    if (!r.ok) { if (r.status === 401 || r.status === 403) location.hash = '#/login'; return; }
    await loadMessages(id, /*scroll*/true);
  };
}

async function populateSidebarSessions(activeId=null){
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/sessions`, { headers });
  if (!r.ok) { if (r.status === 401 || r.status === 403) location.hash = '#/login'; return; }
  const sessions = await r.json();

  const list = $('session-list');
  list.innerHTML =
    sessions.map(s=>{
      const when = new Date(s.updatedAt || s.createdAt || Date.now()).toLocaleString();
      const active = s.id === activeId ? ' style="background:rgba(124,58,237,.12);border-color:rgba(124,58,237,.3)"' : '';
      const title = escapeHtml(s.title||'Chat');
      return `<li><a ${active} href="#/chat/${s.id}">${title}<br><small class="muted">${when}</small></a></li>`;
    }).join('');
}

async function loadMessages(id, scrollAfter=false){
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, { headers });
  if (!r.ok) { if (r.status === 401 || r.status === 403) location.hash = '#/login'; return; }

  const msgs = await r.json();
  const title = $('chat-title');
  if (title && msgs.length) title.textContent = (msgs[0].content || 'Chat').slice(0, 64);

  $('messages').innerHTML = msgs.map(m=>{
    const who = m.role === 'assistant' ? '🤖' : 'You';
    const klass = m.role === 'assistant' ? 'assistant' : 'you';
    return `<div class="msg ${klass}">
              <span class="who">${who}</span>
              <div class="msg-body">${mdToHtml(m.content)}</div>
            </div>`;
  }).join('');


  scrollMessagesBottom();
  if (scrollAfter) setTimeout(scrollMessagesBottom, 50);
}
