/* ════════ Glass Chat — client ════════ */
const socket = io();
let myName = '';
let lastGroupEl = null, lastGroupUser = null, lastGroupTime = 0;
let replyTarget = null, editTarget = null;
let typingTimers = {};
let hasJoinedOnce = false;
let soundOn = localStorage.getItem('gc_sound') !== 'off';
let notifOn = localStorage.getItem('gc_notif') === 'on';
let lastDateKey = '';
const GROUP_GAP = 60000;
const AV_COLORS = ['#3fa9e0','#1f7fc9','#5ab3e6','#2f8fd4','#6cc2ec','#1a6bb8'];
const REACTION_SET = ['👍','❤️','😂','😮','😢','🙏'];

const $ = id => document.getElementById(id);
const userColor = n => { let h=0; for (const c of n) h=(h*31+c.charCodeAt(0))&0xffff; return AV_COLORS[h%AV_COLORS.length]; };
const fmtTime = ts => new Date(ts||Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
const escapeHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function dateKey(ts) { return new Date(ts).toDateString(); }
function dateLabel(ts) {
  const d = new Date(ts), today = new Date(), yest = new Date(Date.now()-86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month:'short', day:'numeric', year: d.getFullYear()!==today.getFullYear()?'numeric':undefined });
}

/* Lightweight inline markdown -> safe HTML (bold/italic/code/links/mentions) */
function renderRich(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/@([A-Za-z0-9_]{1,24})/g, (m, name) => `<span class="mention">@${name}</span>`);
  return html;
}

/* ── particles ── */
class Particles {
  constructor(c){this.c=c;this.ctx=c.getContext('2d');this.p=[];this.raf=null;this._r();window.addEventListener('resize',()=>this._r());}
  _r(){this.c.width=innerWidth;this.c.height=innerHeight;}
  burst(px,py,type){
    const cfg = type==='send'
      ? {n:14,vy:-2.0,spd:[2.5,6],sz:[1.5,3.5],dec:[0.022,0.036],cols:['#3fa9e0','#1f7fc9','#ffffff','#a3cfff']}
      : {n:9,vy:-1.2,spd:[1.2,3.4],sz:[1.2,2.6],dec:[0.026,0.040],cols:['#ffffff','#dff0ff','#bfe6ff']};
    for(let i=0;i<cfg.n;i++){
      const a=(Math.PI*2*i/cfg.n)+(Math.random()-0.5)*1.1;
      const s=cfg.spd[0]+Math.random()*(cfg.spd[1]-cfg.spd[0]);
      this.p.push({x:px,y:py,vx:Math.cos(a)*s,vy:Math.sin(a)*s+cfg.vy,
        r:cfg.sz[0]+Math.random()*(cfg.sz[1]-cfg.sz[0]),a:0.8+Math.random()*0.15,
        col:cfg.cols[Math.floor(Math.random()*cfg.cols.length)],
        dec:cfg.dec[0]+Math.random()*(cfg.dec[1]-cfg.dec[0])});
    }
    if(!this.raf)this._loop();
  }
  _loop(){
    const tick=()=>{
      const{ctx,c}=this; ctx.clearRect(0,0,c.width,c.height);
      this.p=this.p.filter(p=>p.a>0.01);
      for(const p of this.p){
        p.x+=p.vx;p.y+=p.vy;p.vy+=0.11;p.vx*=0.97;p.a-=p.dec;p.r*=0.98;
        ctx.save();ctx.globalAlpha=Math.max(0,p.a);ctx.fillStyle=p.col;
        ctx.beginPath();ctx.arc(p.x,p.y,Math.max(0.1,p.r),0,Math.PI*2);ctx.fill();ctx.restore();
      }
      if(this.p.length){this.raf=requestAnimationFrame(tick);}
      else{this.raf=null;ctx.clearRect(0,0,c.width,c.height);}
    };
    this.raf=requestAnimationFrame(tick);
  }
}
const ps = new Particles($('pcanvas'));
function ripple(x,y){
  const r=document.createElement('div');
  r.className='ripple-ring'; r.style.left=x+'px'; r.style.top=y+'px';
  document.body.appendChild(r);
  setTimeout(()=>r.remove(),520);
}

/* ── notification sound: soft two-note chime, gentle attack/decay ── */
let actx = null;
function playTone(freq, startOffset, dur, vol) {
  const now = actx.currentTime + startOffset;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(vol, now + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  o.connect(g); g.connect(actx.destination);
  o.start(now); o.stop(now + dur + 0.02);
}
function chime() {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext||window.webkitAudioContext)();
    playTone(987.77, 0,    0.16, 0.05);  // B5
    playTone(1318.5, 0.07, 0.22, 0.045); // E6 — gentle rising interval
  } catch {}
}
function sendTick() {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext||window.webkitAudioContext)();
    playTone(740, 0, 0.09, 0.035);
  } catch {}
}

/* ── image resize helper ── */
function fileToResizedDataUrl(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = e => { img.onload = () => {
      let { width:w, height:h } = img;
      if (w > h && w > maxDim) { h = h*maxDim/w; w = maxDim; }
      else if (h > maxDim) { w = w*maxDim/h; h = maxDim; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    }; img.onerror = reject; img.src = e.target.result; };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ── login ── */
const savedName = localStorage.getItem('gc_name');
if (savedName) $('name-input').value = savedName;

function showFieldError(msg) { $('field-error').textContent = msg || ''; }

function joinChat() {
  const nameInp = $('name-input');
  const name = nameInp.value.trim();
  if (!name) {
    nameInp.classList.remove('shake'); void nameInp.offsetWidth; nameInp.classList.add('shake');
    showFieldError('Enter a name to continue');
    setTimeout(()=>nameInp.classList.remove('shake'),450);
    return;
  }
  showFieldError('');
  $('join-btn').disabled = true;
  myName = name;
  localStorage.setItem('gc_name', name);
  socket.emit('join', { name });
}
$('join-btn').addEventListener('click', joinChat);
$('name-input').addEventListener('keydown', e => { if (e.key==='Enter') joinChat(); });

socket.on('name-taken', () => {
  $('join-btn').disabled = false;
  showFieldError('That name is already taken');
  $('name-input').classList.remove('shake'); void $('name-input').offsetWidth; $('name-input').classList.add('shake');
});
socket.on('error-msg', msg => showFieldError(msg));

socket.on('join-success', () => {
  $('join-btn').disabled = false;
  if (!hasJoinedOnce) {
    hasJoinedOnce = true;
    $('login-card').classList.add('leaving');
    setTimeout(() => {
      $('login-screen').classList.add('hidden');
      $('chat-screen').classList.remove('hidden');
      $('msg-input').focus();
    }, 280);
  } else {
    hideReconnectBanner();
  }
});

/* ── grouping / positions ── */
function updatePositions(stack) {
  const bs = stack.querySelectorAll('.bubble-wrap');
  bs.forEach((b, i) => {
    const bub = b.querySelector('.bubble');
    bub.dataset.pos = bs.length===1 ? 'single' : i===0 ? 'first' : i===bs.length-1 ? 'last' : 'middle';
  });
}

function maybeDateDivider(ts) {
  const k = dateKey(ts);
  if (k !== lastDateKey) {
    lastDateKey = k;
    const div = document.createElement('div');
    div.className = 'date-divider';
    div.innerHTML = `<span>${dateLabel(ts)}</span>`;
    $('messages').appendChild(div);
    lastGroupEl = null; lastGroupUser = null;
  }
}

function renderReactions(msgId, reactions) {
  const row = document.createElement('div');
  row.className = 'reactions-row';
  row.dataset.msgId = msgId;
  (reactions||[]).forEach(r => {
    if (!r.users.length) return;
    const pill = document.createElement('span');
    pill.className = 'reaction-pill' + (r.users.includes(myName) ? ' mine' : '');
    pill.textContent = `${r.emoji} ${r.users.length}`;
    pill.title = r.users.join(', ');
    pill.addEventListener('click', () => socket.emit('react', { msgId, emoji: r.emoji }));
    row.appendChild(pill);
  });
  return row;
}

function openEmojiPicker(msgId, anchorEl) {
  document.querySelectorAll('.emoji-picker').forEach(p => p.remove());
  const picker = document.createElement('div');
  picker.className = 'emoji-picker';
  REACTION_SET.forEach(e => {
    const b = document.createElement('button');
    b.textContent = e;
    b.addEventListener('click', () => { socket.emit('react', { msgId, emoji: e }); picker.remove(); });
    picker.appendChild(b);
  });
  anchorEl.style.position = 'relative';
  anchorEl.appendChild(picker);
  const close = ev => { if (!picker.contains(ev.target)) { picker.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function svgIcon(name) {
  const icons = {
    react: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8 15c1 1.2 2.4 2 4 2s3-.8 4-2"/></svg>',
    reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>',
    edit:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };
  return icons[name] || '';
}

function buildBubbleActions(msg, isOwn) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble-actions';
  const reactBtn = document.createElement('button');
  reactBtn.innerHTML = svgIcon('react'); reactBtn.title = 'React';
  reactBtn.addEventListener('click', e => { e.stopPropagation(); openEmojiPicker(msg.id, wrap.parentElement); });
  wrap.appendChild(reactBtn);

  const replyBtn = document.createElement('button');
  replyBtn.innerHTML = svgIcon('reply'); replyBtn.title = 'Reply';
  replyBtn.addEventListener('click', e => { e.stopPropagation(); startReply(msg); });
  wrap.appendChild(replyBtn);

  if (isOwn && !msg.deleted) {
    const editBtn = document.createElement('button');
    editBtn.innerHTML = svgIcon('edit'); editBtn.title = 'Edit';
    editBtn.addEventListener('click', e => { e.stopPropagation(); startEdit(msg); });
    wrap.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.innerHTML = svgIcon('trash'); delBtn.title = 'Delete';
    delBtn.addEventListener('click', e => { e.stopPropagation(); if (confirm('Delete this message?')) socket.emit('delete-msg', { id: msg.id }); });
    wrap.appendChild(delBtn);
  }
  return wrap;
}

/* ── long-press to reveal actions on touch devices ── */
const LONG_PRESS_MS = 420;
const MOVE_CANCEL_PX = 10;
let activeActionsGroup = null;

function closeActiveActions() {
  if (activeActionsGroup) { activeActionsGroup.classList.remove('actions-visible'); activeActionsGroup = null; }
}

function attachLongPress(bubble, group) {
  let timer = null, startX = 0, startY = 0, fired = false;

  bubble.addEventListener('touchstart', e => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; fired = false;
    bubble.classList.add('pressing');
    timer = setTimeout(() => {
      fired = true;
      bubble.classList.remove('pressing');
      if (activeActionsGroup && activeActionsGroup !== group) activeActionsGroup.classList.remove('actions-visible');
      group.classList.add('actions-visible');
      activeActionsGroup = group;
      if (navigator.vibrate) navigator.vibrate(8);
    }, LONG_PRESS_MS);
  }, { passive: true });

  bubble.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > MOVE_CANCEL_PX || Math.abs(t.clientY - startY) > MOVE_CANCEL_PX) {
      clearTimeout(timer);
      bubble.classList.remove('pressing');
    }
  }, { passive: true });

  bubble.addEventListener('touchend', () => {
    clearTimeout(timer);
    bubble.classList.remove('pressing');
  });
  bubble.addEventListener('touchcancel', () => {
    clearTimeout(timer);
    bubble.classList.remove('pressing');
  });
}

document.addEventListener('touchstart', e => {
  if (activeActionsGroup && !activeActionsGroup.contains(e.target)) closeActiveActions();
}, { passive: true });
document.addEventListener('click', e => {
  if (activeActionsGroup && !activeActionsGroup.contains(e.target)) closeActiveActions();
});


function startReply(msg) {
  replyTarget = msg;
  $('reply-bar').classList.add('open');
  $('reply-bar-text').innerHTML = `Replying to <b>${escapeHtml(msg.user)}</b>: ${escapeHtml((msg.text||'📷 image').slice(0,60))}`;
  $('msg-input').focus();
}
$('reply-bar-close').addEventListener('click', () => { replyTarget = null; $('reply-bar').classList.remove('open'); });

function startEdit(msg) {
  editTarget = msg;
  $('edit-bar').classList.add('open');
  $('msg-input').value = msg.text;
  $('msg-input').focus();
  autoResize();
}
$('edit-bar-close').addEventListener('click', () => { editTarget = null; $('edit-bar').classList.remove('open'); $('msg-input').value=''; });

/* ── message rendering ── */
function addMessage(data, isOwn, fromHistory) {
  removeTypingRow();
  maybeDateDivider(data.ts || Date.now());
  const box = $('messages');
  const ts = data.ts || Date.now(), user = data.user;
  const same = lastGroupEl && lastGroupUser === user && (ts - lastGroupTime) < GROUP_GAP;
  let group, stack;

  if (same) {
    group = lastGroupEl; stack = group.querySelector('.bubble-stack');
    const oldTs = stack.querySelector(':scope > .ts'); if (oldTs) oldTs.remove();
    group.classList.add('tight');
  } else {
    group = document.createElement('div');
    group.className = `msg-group ${isOwn ? 'own' : 'other'}`;
    if (!isOwn) {
      const av = document.createElement('div');
      av.className = 'avatar';
      av.style.background = userColor(user);
      av.textContent = user[0].toUpperCase();
      group.appendChild(av);
    }
    stack = document.createElement('div'); stack.className = 'bubble-stack';
    if (!isOwn) {
      const nm = document.createElement('div'); nm.className = 'sender-name'; nm.textContent = user;
      stack.appendChild(nm);
    }
    group.appendChild(stack); box.appendChild(group);
  }

  const bubbleWrap = document.createElement('div');
  bubbleWrap.className = 'bubble-wrap';
  bubbleWrap.dataset.msgId = data.id || '';

  const bubble = document.createElement('div');
  bubble.className = 'bubble' + (fromHistory ? '' : ' pop') + (data.deleted ? ' deleted' : '');
  bubble.dataset.id = data.id || '';
  if (data.text && myName && data.text.toLowerCase().includes('@'+myName.toLowerCase()) && !isOwn) bubble.classList.add('mentioned');

  if (data.deleted) {
    bubble.textContent = 'Message deleted';
  } else {
    if (data.replyTo) {
      const q = document.createElement('div'); q.className = 'reply-quote';
      q.innerHTML = `<b>${escapeHtml(data.replyTo.user)}</b>: ${escapeHtml(data.replyTo.text)}`;
      bubble.appendChild(q);
    }
    if (data.text) {
      const textEl = document.createElement('div');
      textEl.innerHTML = renderRich(data.text);
      bubble.appendChild(textEl);
    }
    if (data.image) {
      const img = document.createElement('img');
      img.className = 'chat-img'; img.src = data.image;
      img.addEventListener('click', e => { e.stopPropagation(); openLightbox(data.image); });
      bubble.appendChild(img);
    }
  }
  bubble.addEventListener('dblclick', () => openEmojiPicker(data.id, bubbleWrap));
  attachLongPress(bubble, group);

  if (isOwn) bubbleWrap.appendChild(buildBubbleActions(data, true));
  bubbleWrap.appendChild(bubble);
  if (!isOwn) bubbleWrap.appendChild(buildBubbleActions(data, false));
  stack.appendChild(bubbleWrap);

  if (!data.deleted) {
    const rxRow = renderReactions(data.id, data.reactions);
    stack.appendChild(rxRow);
  }

  const tsEl = document.createElement('div'); tsEl.className = 'ts';
  const tsText = document.createElement('span');
  tsText.textContent = fmtTime(ts) + (data.edited ? ' · edited' : '');
  tsEl.appendChild(tsText);
  if (isOwn && !data.deleted) {
    const rc = document.createElement('span');
    rc.className = 'receipt'; rc.dataset.id = data.id || ''; rc.textContent = 'Read';
    if (data.seenBy && data.seenBy.length) rc.classList.add('seen');
    tsEl.appendChild(rc);
  }
  stack.appendChild(tsEl);

  updatePositions(stack);
  lastGroupEl = group; lastGroupUser = user; lastGroupTime = ts;

  const atBottom = isNearBottom();
  if (isOwn || atBottom || fromHistory) { box.scrollTop = box.scrollHeight; }
  else { bumpUnread(); }

  if (!isOwn && data.id && !data.deleted) socket.emit('seen', { id: data.id });
  if (!isOwn && !fromHistory) {
    chime();
    if (notifOn && document.hidden) notify(user, data.text || 'Sent an image');
  }
}

function addSystem(text) {
  removeTypingRow();
  const box = $('messages');
  const div = document.createElement('div'); div.className = 'msg-system'; div.textContent = text;
  box.appendChild(div); box.scrollTop = box.scrollHeight;
  lastGroupEl = null; lastGroupUser = null;
}

/* ── typing ── */
function removeTypingRow() { const row = $('typing-row'); if (row) row.remove(); }
function showTyping(user) {
  removeTypingRow();
  const box = $('messages');
  const row = document.createElement('div'); row.id = 'typing-row'; row.className = 'typing-row';
  const av = document.createElement('div'); av.className = 'avatar';
  av.style.background = userColor(user); av.textContent = user[0].toUpperCase();
  const bub = document.createElement('div'); bub.className = 'typing-bubble';
  bub.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  row.appendChild(av); row.appendChild(bub);
  box.appendChild(row); box.scrollTop = box.scrollHeight;
}
let lastTypingEmit = 0;
$('msg-input').addEventListener('input', () => {
  if (!myName) return;
  const now = Date.now();
  if (now - lastTypingEmit > 1200) { socket.emit('typing'); lastTypingEmit = now; }
  autoResize();
});
function autoResize() {
  const el = $('msg-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

/* ── send ── */
let pendingImage = null;
function sendMsg() {
  const inp = $('msg-input'); const text = inp.value.trim();
  if (!text && !pendingImage) return;

  if (editTarget) {
    socket.emit('edit-msg', { id: editTarget.id, text });
    editTarget = null; $('edit-bar').classList.remove('open');
    inp.value = ''; autoResize();
    return;
  }

  socket.emit('message', { text, image: pendingImage, replyTo: replyTarget ? { id: replyTarget.id, user: replyTarget.user, text: replyTarget.text } : null });
  inp.value = ''; autoResize();
  pendingImage = null; $('img-preview-bar').classList.remove('open'); $('img-preview-bar').innerHTML = '';
  replyTarget = null; $('reply-bar').classList.remove('open');

  sendTick();
  const btn = $('send-btn');
  const r = btn.getBoundingClientRect();
  ps.burst(r.left + r.width/2, r.top + r.height/2, 'send');
  ripple(r.left + r.width/2, r.top + r.height/2);
  btn.classList.remove('fire'); void btn.offsetWidth; btn.classList.add('fire');
}
$('send-btn').addEventListener('click', sendMsg);
$('msg-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });

/* ── image attach / paste / drag ── */
async function attachImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const dataUrl = await fileToResizedDataUrl(file, 640, 0.75);
    pendingImage = dataUrl;
    const bar = $('img-preview-bar');
    bar.innerHTML = '';
    const img = document.createElement('img'); img.src = dataUrl;
    const rm = document.createElement('button'); rm.innerHTML = svgIcon('close');
    rm.addEventListener('click', () => { pendingImage = null; bar.classList.remove('open'); bar.innerHTML = ''; });
    bar.appendChild(img); bar.appendChild(rm);
    bar.classList.add('open');
  } catch {}
}
$('attach-btn').addEventListener('click', () => $('img-upload').click());
$('img-upload').addEventListener('change', e => attachImage(e.target.files[0]));
$('msg-input').addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items||[])].find(i => i.type.startsWith('image/'));
  if (item) { attachImage(item.getAsFile()); e.preventDefault(); }
});
const chatCard = document.querySelector('#chat-screen .chat-card');
chatCard.addEventListener('dragover', e => e.preventDefault());
chatCard.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) attachImage(file);
});

function openLightbox(src) {
  const lb = document.createElement('div'); lb.className = 'lightbox';
  const img = document.createElement('img'); img.src = src;
  lb.appendChild(img);
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
}

/* ── search ── */
$('search-btn').addEventListener('click', () => {
  const bar = $('search-bar');
  bar.classList.toggle('open');
  if (bar.classList.contains('open')) { $('search-input').focus(); $('search-btn').classList.add('active'); }
  else { $('search-btn').classList.remove('active'); clearSearchHighlights(); }
});
function clearSearchHighlights() { document.querySelectorAll('.search-hit').forEach(b => b.classList.remove('search-hit')); }
$('search-input').addEventListener('input', e => {
  clearSearchHighlights();
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  let first = null;
  document.querySelectorAll('.bubble').forEach(b => {
    if (b.textContent.toLowerCase().includes(q)) { b.classList.add('search-hit'); if (!first) first = b; }
  });
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

/* ── scroll to bottom / unread ── */
function isNearBottom() {
  const box = $('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}
let unreadCount = 0;
function bumpUnread() {
  unreadCount++;
  const btn = $('scroll-bottom-btn');
  btn.classList.add('show');
  let dot = btn.querySelector('.unread-dot');
  if (!dot) { dot = document.createElement('span'); dot.className = 'unread-dot'; btn.appendChild(dot); }
  dot.textContent = unreadCount > 9 ? '9+' : unreadCount;
  updateTitleBadge();
}
function clearUnread() {
  unreadCount = 0;
  const btn = $('scroll-bottom-btn');
  btn.classList.remove('show');
  const dot = btn.querySelector('.unread-dot'); if (dot) dot.remove();
  updateTitleBadge();
}
function updateTitleBadge() {
  document.title = unreadCount > 0 ? `(${unreadCount}) Glass Chat` : 'Glass Chat';
}
$('messages').addEventListener('scroll', () => { if (isNearBottom()) clearUnread(); });
$('scroll-bottom-btn').addEventListener('click', () => {
  $('messages').scrollTop = $('messages').scrollHeight;
  clearUnread();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) clearUnread(); });

/* ── notifications ── */
function notify(user, text) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(`${user} — Glass Chat`, { body: text.slice(0,120), icon: 'favicon-32.png' }); } catch {}
}
$('notif-btn').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    notifOn = perm === 'granted';
  } else {
    notifOn = !notifOn;
  }
  localStorage.setItem('gc_notif', notifOn ? 'on' : 'off');
  $('notif-btn').classList.toggle('active', notifOn);
});
if (notifOn) $('notif-btn').classList.add('active');

$('sound-btn').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('gc_sound', soundOn ? 'on' : 'off');
  $('sound-btn').classList.toggle('active', soundOn);
  if (soundOn) chime();
});
if (soundOn) $('sound-btn').classList.add('active');

/* ── load more (pagination) ── */
let oldestTs = null, hasMoreHistory = false;
function renderLoadMoreRow() {
  const existing = document.getElementById('load-more-row');
  if (existing) existing.remove();
  if (!hasMoreHistory) return;
  const row = document.createElement('div'); row.id = 'load-more-row'; row.className = 'load-more-row';
  const btn = document.createElement('button'); btn.className = 'load-more-btn'; btn.textContent = 'Load earlier messages';
  btn.addEventListener('click', () => socket.emit('load-more', { before: oldestTs }));
  row.appendChild(btn);
  $('messages').prepend(row);
}

/* ── reconnect banner ── */
function showReconnectBanner() {
  let b = document.getElementById('reconnect-banner');
  if (!b) {
    b = document.createElement('div'); b.id = 'reconnect-banner';
    b.textContent = 'Connection lost — reconnecting…';
    document.querySelector('#chat-screen .chat-card').prepend(b);
  }
}
function hideReconnectBanner() { const b = document.getElementById('reconnect-banner'); if (b) b.remove(); }

/* ── socket events ── */
socket.on('history', msgs => {
  $('messages').innerHTML = '';
  lastGroupEl = null; lastGroupUser = null; lastDateKey = '';
  msgs.forEach(m => addMessage(m, m.user === myName, true));
  oldestTs = msgs.length ? msgs[0].ts : null;
  $('messages').scrollTop = $('messages').scrollHeight;
});
socket.on('history-has-more', has => { hasMoreHistory = has; renderLoadMoreRow(); });
socket.on('more-history', ({ msgs, hasMore }) => {
  const box = $('messages');
  const prevHeight = box.scrollHeight;
  lastGroupEl = null; lastGroupUser = null;
  msgs.forEach(m => addMessage(m, m.user === myName, true));
  hasMoreHistory = hasMore;
  oldestTs = msgs.length ? msgs[0].ts : oldestTs;
  renderLoadMoreRow();
  box.scrollTop = box.scrollHeight - prevHeight;
});

socket.on('message', data => {
  const isOwn = data.socketId === socket.id;
  addMessage(data, isOwn, false);
  if (!isOwn) {
    const r = $('messages').getBoundingClientRect();
    ps.burst(r.left + 60, r.bottom - 75, 'recv');
  }
});
socket.on('msg-edited', ({ id, text }) => {
  const bubble = document.querySelector(`.bubble[data-id="${id}"]`);
  if (!bubble) return;
  const firstDiv = bubble.querySelector(':scope > div');
  if (firstDiv && !firstDiv.classList.contains('reply-quote')) firstDiv.innerHTML = renderRich(text);
  else bubble.insertAdjacentHTML('beforeend', renderRich(text));
  const ts = bubble.closest('.bubble-stack')?.querySelector('.ts span:first-child');
  if (ts && !ts.textContent.includes('edited')) ts.textContent += ' · edited';
});
socket.on('msg-deleted', ({ id }) => {
  const bubble = document.querySelector(`.bubble[data-id="${id}"]`);
  if (!bubble) return;
  bubble.classList.add('deleted');
  bubble.innerHTML = 'Message deleted';
});
socket.on('reaction-update', ({ msgId, reactions }) => {
  const row = document.querySelector(`.reactions-row[data-msg-id="${msgId}"]`);
  if (!row) return;
  const fresh = renderReactions(msgId, reactions);
  row.replaceWith(fresh);
});
socket.on('seen-update', ({ id }) => {
  const rc = document.querySelector(`.receipt[data-id="${id}"]`);
  if (rc && !rc.classList.contains('seen')) rc.classList.add('seen');
});
socket.on('link-preview', ({ msgId, preview }) => {
  const bubble = document.querySelector(`.bubble[data-id="${msgId}"]`);
  if (!bubble || bubble.querySelector('.link-preview')) return;
  const a = document.createElement('a');
  a.className = 'link-preview'; a.href = preview.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.innerHTML = `${preview.image ? `<img src="${preview.image}" loading="lazy"/>` : ''}
    <div class="lp-body"><div class="lp-title">${escapeHtml(preview.title||'')}</div><div class="lp-desc">${escapeHtml(preview.desc||'')}</div></div>`;
  bubble.appendChild(a);
});
socket.on('typing', user => {
  if (typeof user !== 'string' || user === myName) return;
  showTyping(user);
  clearTimeout(typingTimers[user]);
  typingTimers[user] = setTimeout(removeTypingRow, 2200);
});
socket.on('system', text => addSystem(text));
socket.on('user-count', n => { $('online-count').textContent = `${n} online`; });

socket.on('disconnect', () => { if (hasJoinedOnce) showReconnectBanner(); });
socket.on('connect', () => {
  if (hasJoinedOnce && myName) socket.emit('join', { name: myName });
});
