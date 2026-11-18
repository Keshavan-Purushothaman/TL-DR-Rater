// TL;DR Rater: one headline at a time. Swipe up = must see, right = yes, left = no.
// Buttons for junk, seen this story, skip and undo. Every answer is logged on the phone and can be exported.
"use strict";

const FEED_URL = "headlines.json";
const DAILY_GOAL = 100;
const SWIPE_PX = 90;                 // how far a card must be dragged to count
const LOG_VERSION = 1;
const STATE_KEY = "tldr.rater.state.v1";
const COUNTED = { must: 1, yes: 1, no: 1, junk: 1, dup: 1 };     // skip is not a rating
const LABEL = { must: "Must see", yes: "Yes", no: "No", junk: "Junk", dup: "Seen this story", skip: "Skipped" };
const SECTIONS = ["India", "World", "Bengaluru", "Hyderabad", "Business", "Sports", "Movies", "Tech/Science"];

const $ = (id) => document.getElementById(id);
const stage = $("stage"), tpl = $("card-tpl"), root = document.documentElement;

// =====================================================================
// State kept on the phone
// =====================================================================
const state = Object.assign(
  { rated: {}, day: { date: "", count: 0 }, coached: false, session: null },
  JSON.parse(localStorage.getItem(STATE_KEY) || "{}")
);
function saveState() { localStorage.setItem(STATE_KEY, JSON.stringify(state)); }
function today() { return new Date().toLocaleDateString("en-CA"); }          // YYYY-MM-DD, local time
function rollDay() { if (state.day.date !== today()) state.day = { date: today(), count: 0 }; }
function pruneRated() {                                  // headlines live two days; forget answers after ten
  const cutoff = Date.now() - 10 * 864e5;
  for (const k of Object.keys(state.rated)) if (state.rated[k][1] < cutoff) delete state.rated[k];
}

// ---------- event log: IndexedDB, append-only, with an in-memory fallback ----------
const DB = (() => {
  let dbp, mem = null;
  function open() {
    if (dbp) return dbp;
    if (window.__NO_IDB__) { mem = []; return (dbp = Promise.resolve(null)); }
    dbp = new Promise((resolve) => {
      const giveUp = setTimeout(() => { mem = mem || []; resolve(null); }, 1500);
      let req;
      try { req = indexedDB.open("tldr-rater", 1); } catch (e) { clearTimeout(giveUp); mem = []; return resolve(null); }
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore("events", { keyPath: "seq", autoIncrement: true });
        s.createIndex("ts", "ts"); s.createIndex("id", "id");
      };
      req.onsuccess = () => { clearTimeout(giveUp); resolve(req.result); };
      req.onerror = () => { clearTimeout(giveUp); mem = mem || []; resolve(null); };
    });
    return dbp;
  }
  async function add(row) {
    const db = await open();
    if (!db) { mem.push(Object.assign({ seq: mem.length + 1 }, row)); return; }
    return new Promise((res, rej) => {
      const tx = db.transaction("events", "readwrite");
      tx.objectStore("events").add(row); tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  }
  async function all() {
    const db = await open();
    if (!db) return mem.slice();
    return new Promise((res, rej) => {
      const req = db.transaction("events").objectStore("events").getAll();
      req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
    });
  }
  return { add, all };
})();

let feedGeneratedAt = null, sessionCount = 0;
function ensureSession() {
  if (!state.session || Date.now() - (state.session.last || 0) > 30 * 60000) {
    state.session = { id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), last: Date.now() };
    sessionCount = 0;
  }
  state.session.last = Date.now(); saveState();
}
function log(event, item, extra) {
  const now = new Date();
  const row = Object.assign({
    v: LOG_VERSION, ts: now.toISOString(), event, id: item ? item.id : null,
    session_id: state.session && state.session.id,
    context: { hour: now.getHours(), weekday: now.getDay() },
    feed_generated_at: feedGeneratedAt,
  }, extra || {});
  if (item) {
    row.item = {
      title: item.title, desc: item.desc || "", desc_shown: !!item.desc, section: item.section, publisher: item.publisher,
      feed: item.feed, src: item.src, sources: item.sources || 1, also: item.also || [], url: item.url,
      published_at: item.published_at, age_hours: Math.round((Date.now() - new Date(item.published_at)) / 36e5 * 10) / 10,
    };
  }
  DB.add(row).catch((e) => console.warn("log failed", e));
}

// =====================================================================
// Helpers
// =====================================================================
function ago(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000), h = Math.floor(m / 60);
  if (m < 60) return Math.max(m, 1) + "m ago";
  if (h < 24) return h + "h ago";
  if (h < 48) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function catVar(section) {
  const key = section === "Tech/Science" ? "Tech" : section;
  return "var(--cat-" + (SECTIONS.includes(section) ? key : "Other") + ")";
}
let toastTimer;
function toast(text) {
  const el = $("toast"); el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 1400);
}

// =====================================================================
// Cards
// =====================================================================
let queue = [];            // headlines still to rate, in order
let history = [];          // recent answers, for undo
let busy = false, shownAt = Date.now();

function buildCard(item) {
  const card = tpl.content.firstElementChild.cloneNode(true);
  const q = (sel) => card.querySelector(sel);
  card.dataset.id = item.id;
  card.style.setProperty("--cat", catVar(item.section));
  q(".cat").textContent = item.section;
  q(".pub").textContent = item.publisher;
  q(".age").textContent = ago(item.published_at);
  q(".headline").textContent = item.title;
  if (item.title.length > 95) card.classList.add("long");
  if (item.desc) { q(".desc").textContent = item.desc; card.classList.add("has-desc"); }
  if ((item.sources || 1) > 1) {
    const also = q(".also");
    const b = document.createElement("b"); b.textContent = item.sources + " sources";
    also.append("Reported by ", b, item.also && item.also.length ? ": also " + item.also.join(", ") : "");
  }
  const open = q(".open");
  open.href = item.url;
  open.addEventListener("click", () => log("open", item));
  return card;
}

function mount() {
  stage.replaceChildren();
  if (!queue.length) { showEnd(); updateHeader(); return; }
  if (queue[1]) { const under = buildCard(queue[1]); under.classList.add("under"); stage.appendChild(under); }
  const top = buildCard(queue[0]); top.classList.add("enter");
  stage.appendChild(top);
  attachDrag(top);
  shownAt = Date.now();
  updateHeader();
}

function showEnd() {
  const total = Object.keys(state.rated).length;
  const end = document.createElement("div"); end.className = "end";
  const box = document.createElement("div");
  const h = document.createElement("h2"); h.textContent = "All caught up";
  const p = document.createElement("p"); p.textContent = total + " headlines answered so far. New ones arrive every few hours.";
  const again = document.createElement("button"); again.className = "btn"; again.textContent = "Check for new headlines";
  again.onclick = () => location.reload();
  const exp = document.createElement("button"); exp.className = "btn ghost"; exp.textContent = "Export ratings";
  exp.onclick = exportRatings;
  box.append(h, p, again, exp); end.appendChild(box); stage.appendChild(end);
}

function updateHeader() {
  rollDay();
  $("today").textContent = state.day.count;
  $("goalText").textContent = state.day.count >= DAILY_GOAL ? "\u00b7 goal reached" : "\u00b7 goal " + DAILY_GOAL;
  $("left").textContent = queue.length ? queue.length + " to go" : "";
  const fill = $("barfill");
  fill.style.width = Math.min(100, state.day.count / DAILY_GOAL * 100) + "%";
  fill.classList.toggle("done", state.day.count >= DAILY_GOAL);
  $("b-undo").disabled = !history.length;
  for (const id of ["b-no", "b-must", "b-yes", "b-junk", "b-dup", "b-skip"]) $(id).disabled = !queue.length;
}

// ---------- answering ----------
function commit(answer, method) {
  const item = queue[0];
  if (!item || busy) return;
  busy = true; ensureSession(); rollDay();
  const ms = Date.now() - shownAt;
  sessionCount++;
  log("rate", item, { answer, method, ms, position: sessionCount });
  state.rated[item.id] = [answer, Date.now()];
  if (COUNTED[answer]) state.day.count++;
  saveState();
  history.push({ item, answer }); if (history.length > 30) history.shift();

  const card = stage.lastElementChild;
  if (card && card.classList.contains("card")) {
    card.classList.remove("dragging", "enter");
    card.style.transform = "";
    card.classList.add(answer === "yes" ? "fly-yes" : answer === "no" ? "fly-no" : answer === "must" ? "fly-must" : "fly-down");
  }
  if (!COUNTED[answer] || answer === "junk" || answer === "dup") toast(LABEL[answer]);
  if (state.day.count === DAILY_GOAL && COUNTED[answer]) toast("Daily goal reached");
  setTimeout(() => { queue.shift(); busy = false; mount(); }, 200);
}

function undo() {
  if (busy) return;
  const last = history.pop();
  if (!last) { toast("Nothing to undo"); return; }
  delete state.rated[last.item.id];
  if (COUNTED[last.answer]) { rollDay(); state.day.count = Math.max(0, state.day.count - 1); }
  saveState();
  log("undo", last.item, { answer: last.answer });
  queue.unshift(last.item);
  mount();
  toast("Undone: " + LABEL[last.answer]);
}

// ---------- swiping ----------
function decide(dx, dy) {
  if (dy < -SWIPE_PX && Math.abs(dy) > Math.abs(dx)) return "must";
  if (dx > SWIPE_PX) return "yes";
  if (dx < -SWIPE_PX) return "no";
  return null;
}
function attachDrag(card) {
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false, pid = null;
  const stamps = { yes: card.querySelector(".s-yes"), no: card.querySelector(".s-no"), must: card.querySelector(".s-must") };
  const clamp = (v) => Math.max(0, Math.min(1, v));
  function paint() {
    card.style.transform = "translate(" + dx + "px," + (dy < 0 ? dy : dy * 0.25) + "px) rotate(" + dx * 0.045 + "deg)";
    const vertical = dy < 0 && Math.abs(dy) > Math.abs(dx);
    stamps.must.style.opacity = vertical ? clamp(-dy / SWIPE_PX) : 0;
    stamps.yes.style.opacity = vertical ? 0 : clamp(dx / SWIPE_PX);
    stamps.no.style.opacity = vertical ? 0 : clamp(-dx / SWIPE_PX);
  }
  function reset() {
    card.classList.remove("dragging"); card.style.transform = "";
    for (const k in stamps) stamps[k].style.opacity = 0;
  }
  card.addEventListener("pointerdown", (e) => {
    if (busy || e.target.closest("a")) return;
    dragging = true; pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = dy = 0;
    try { card.setPointerCapture(pid); } catch (err) {}
    card.classList.remove("enter"); card.classList.add("dragging");
  });
  card.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pid) return;
    dx = e.clientX - sx; dy = e.clientY - sy; paint();
  });
  card.addEventListener("pointerup", (e) => {
    if (!dragging || e.pointerId !== pid) return;
    dragging = false;
    const answer = decide(dx, dy);
    if (answer) commit(answer, "swipe"); else reset();
  });
  card.addEventListener("pointercancel", () => { dragging = false; reset(); });
}

// ---------- buttons and keys ----------
function press(answer, btnId) {
  const b = $(btnId); if (b) { b.classList.add("flash"); setTimeout(() => b.classList.remove("flash"), 150); }
  commit(answer, "button");
}
$("b-no").onclick = () => press("no", "b-no");
$("b-yes").onclick = () => press("yes", "b-yes");
$("b-must").onclick = () => press("must", "b-must");
$("b-junk").onclick = () => press("junk", "b-junk");
$("b-dup").onclick = () => press("dup", "b-dup");
$("b-skip").onclick = () => press("skip", "b-skip");
$("b-undo").onclick = undo;
addEventListener("keydown", (e) => {
  if (!$("sheet").hidden || !$("coach").hidden) return;
  const map = { ArrowRight: "yes", ArrowLeft: "no", ArrowUp: "must", j: "junk", d: "dup", s: "skip" };
  if (map[e.key]) { e.preventDefault(); commit(map[e.key], "key"); }
  else if (e.key === "z" || e.key === "Backspace") { e.preventDefault(); undo(); }
});

// =====================================================================
// Your ratings (cloud button) and export
// =====================================================================
async function latestAnswers() {
  const rows = await DB.all();
  const latest = new Map();                      // id -> last rate event, with undos applied
  for (const r of rows) {
    if (r.event === "rate") latest.set(r.id, r);
    else if (r.event === "undo") latest.delete(r.id);
  }
  return { rows, latest: [...latest.values()] };
}
async function openSheet() {
  const { latest } = await latestAnswers();
  const tot = { must: 0, yes: 0, no: 0, junk: 0, dup: 0, skip: 0 };
  const sec = {}; SECTIONS.forEach((s) => { sec[s] = { must: 0, yes: 0, no: 0 }; });
  for (const r of latest) {
    tot[r.answer] = (tot[r.answer] || 0) + 1;
    const s = r.item && sec[r.item.section];
    if (s && s[r.answer] !== undefined) s[r.answer]++;
  }
  const totals = $("totals"); totals.replaceChildren();
  for (const k of ["must", "yes", "no", "junk", "dup", "skip"]) {
    const c = document.createElement("span"); c.className = "chip " + k;
    const b = document.createElement("b"); b.textContent = tot[k];
    c.append(LABEL[k], b); totals.appendChild(c);
  }
  const table = $("sections"); table.replaceChildren();
  for (const s of SECTIONS) {
    const n = sec[s].must + sec[s].yes + sec[s].no, liked = sec[s].must + sec[s].yes;
    const row = document.createElement("div"); row.className = "sec-row";
    const name = document.createElement("span"); name.className = "sec-name"; name.textContent = s; name.style.setProperty("--cat", catVar(s));
    const bar = document.createElement("span"); bar.className = "sec-bar" + (n ? "" : " empty");
    const fill = document.createElement("i"); fill.style.width = (n ? liked / n * 100 : 0) + "%"; bar.appendChild(fill);
    const num = document.createElement("span"); num.className = "sec-num";
    num.textContent = n ? Math.round(liked / n * 100) + "% of " + n : "none yet";
    row.append(name, bar, num); table.appendChild(row);
  }
  $("sheetNote").textContent = "Green is the share you said Yes or Must see to in each section. Export saves every answer as a file on this phone.";
  $("sheet").hidden = false;
}
async function exportRatings() {
  const { rows, latest } = await latestAnswers();
  const data = { app: "tldr-rater", exported_at: new Date().toISOString(), answers: latest.length, events: rows };
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "tldr-ratings-" + today() + ".json" });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  log("export", null, { events: rows.length });
  toast("Saved to Downloads");
}
$("data").onclick = openSheet;
$("export").onclick = exportRatings;
$("close").onclick = () => { $("sheet").hidden = true; };
$("help").onclick = () => { $("coach").hidden = false; };
$("coachOk").onclick = () => { $("coach").hidden = true; state.coached = true; saveState(); shownAt = Date.now(); };

// ---------- theme (shared with the reader) ----------
const prefersDark = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(mode) { root.classList.toggle("dark", mode === "dark"); root.classList.toggle("light", mode === "light"); }
const urlTheme = new URLSearchParams(location.search).get("theme");
applyTheme(urlTheme || localStorage.getItem("theme") || (prefersDark.matches ? "dark" : "light"));
$("theme").onclick = () => {
  const next = root.classList.contains("dark") ? "light" : "dark";
  applyTheme(next); localStorage.setItem("theme", next);
};

// =====================================================================
// Start
// =====================================================================
async function loadHeadlines() {
  if (window.__HEADLINES__) return window.__HEADLINES__;            // test harness
  const res = await fetch(FEED_URL, { cache: "no-cache" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
function fillQueue(data) {
  feedGeneratedAt = data.generated_at;
  const have = new Set(queue.map((i) => i.id));
  for (const it of data.items) if (!state.rated[it.id] && !have.has(it.id)) queue.push(it);
}
let lastFetch = 0;
async function start() {
  pruneRated(); rollDay(); ensureSession();
  try { fillQueue(await loadHeadlines()); lastFetch = Date.now(); }
  catch (e) {
    const end = document.createElement("div"); end.className = "end";
    const box = document.createElement("div");
    const h = document.createElement("h2"); h.textContent = "Couldn't load headlines";
    const p = document.createElement("p"); p.textContent = e.message + ". Check your connection and try again.";
    box.append(h, p); end.appendChild(box); stage.replaceChildren(end); updateHeader();
    return;
  }
  mount();
  if (!state.coached) $("coach").hidden = false;
}
// Coming back to the app after a while: quietly add any new headlines to the end of the queue.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  shownAt = Date.now();
  if (Date.now() - lastFetch < 20 * 60000 || window.__HEADLINES__) return;
  try { const wasEmpty = !queue.length; fillQueue(await loadHeadlines()); lastFetch = Date.now(); if (wasEmpty) mount(); else updateHeader(); } catch (e) {}
});

start();
