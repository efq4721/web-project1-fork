// ---------- CONFIG ----------
const API_BASE = ''; // same origin (http://localhost:<PORT>)

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
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

function escapeHtml(s){return s.replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[c]));}

// ---------- ROUTER ----------
window.addEventListener('hashchange', route);

// Log and route on auth changes (so UI updates after sign-in/out)
onAuthStateChanged(auth, (u) => {
  console.log('auth state:', !!u, u?.uid || null);
  route();
});

// Handle redirect-completion (if popup was blocked)
getRedirectResult(auth).catch(e => console.log('redirect sign-in error:', e));

function route(){
  const [_, page, id] = (location.hash || '#/login').split('/');

  // If we're on /login and already signed in, go to /chat
  if (page === 'login') {
    if (auth.currentUser) {
      location.hash = '#/chat';
      return;
    }
    return renderLogin();
  }

  // For any other page, require sign-in
  if (!auth.currentUser) {
    location.hash = '#/login';
    return;
  }

  if (page === 'chat' && !id) return renderChatList();
  if (page === 'chat' && id)  return renderChatDetail(id);

  // default
  location.hash = '#/login';
}

// ---------- VIEWS ----------
function renderLogin(){
  $('app').innerHTML = tpl('tpl-login');
  $('btn-google').onclick = async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
      // onAuthStateChanged will fire and route() will push you to /chat
    } catch (e) {
      console.log('Popup blocked, using redirect:', e);
      await signInWithRedirect(auth, new GoogleAuthProvider());
    }
  };
}

async function renderChatList(){
  $('app').innerHTML = tpl('tpl-chat');

  // buttons
  $('btn-logout').onclick = () => signOut(auth);
  $('btn-new').onclick = async ()=>{
    const headers = { 'Content-Type':'application/json', ...(await authHeader()) };
    const r = await fetch(`${API_BASE}/api/sessions`, { method:'POST', headers, body: JSON.stringify({ title:'New chat' }) });
    if (!r.ok) {
      console.error('Create session failed', r.status);
      if (r.status === 401 || r.status === 403) location.hash = '#/login';
      return;
    }
    const j = await r.json();
    location.hash = `#/chat/${j.id}`;
  };

  // load sessions
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/sessions`, { headers });
  if (!r.ok) {
    console.error('List sessions failed', r.status);
    if (r.status === 401 || r.status === 403) location.hash = '#/login';
    return;
  }
  const sessions = await r.json();

  $('session-list').innerHTML =
    sessions.map(s=>{
      const when = new Date(s.updatedAt || s.createdAt || Date.now()).toLocaleString();
      return `<li><a href="#/chat/${s.id}">${escapeHtml(s.title||s.id)}</a> <small>${when}</small></li>`;
    }).join('');
}

async function renderChatDetail(id){
  $('app').innerHTML = tpl('tpl-chat-detail');

  // logout on detail page too
  const btnLogout = $('btn-logout');
  if (btnLogout) btnLogout.onclick = () => signOut(auth);

  await loadMessages(id);

  $('msg-form').onsubmit = async (e)=>{
    e.preventDefault();
    const input = $('msg');
    const content = (input.value || '').trim();
    if(!content) return;
    input.value = '';

    const headers = { 'Content-Type':'application/json', ...(await authHeader()) };
    const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, {
      method:'POST', headers, body: JSON.stringify({ content })
    });
    if (!r.ok) {
      console.error('Send message failed', r.status);
      if (r.status === 401 || r.status === 403) location.hash = '#/login';
      return;
    }
    await loadMessages(id);
  };
}

async function loadMessages(id){
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/sessions/${id}/messages`, { headers });
  if (!r.ok) {
    console.error('Load messages failed', r.status);
    if (r.status === 401 || r.status === 403) location.hash = '#/login';
    return;
  }
  const msgs = await r.json();
  $('messages').innerHTML =
    msgs.map(m=>`<div><b>${m.role==='assistant'?'🤖':'You'}:</b> ${escapeHtml(m.content||'')}</div>`).join('');
}
