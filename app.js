"use strict";
/* Prot'Claude — suivi du quota de protéines journalier, hors ligne.
   Les données restent sur le téléphone (IndexedDB). Seule la recherche d'un code-barres inconnu
   passe par Open Food Facts, et demande donc du réseau. */

const APP_VERSION = "1.0.0";

/* ---------- Stockage ---------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open("protclaude", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("kv", mode); const r = fn(t.objectStore("kv"));
      t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx("readonly", s => s.get(k)),
    set: (k, v) => tx("readwrite", s => s.put(v, k)),
  };
})();

/* foods   : { id, name, brand, mode: "g" (pour 100 g) | "u" (par unité), rate, unit, portion, barcode, uses, last, created }
   entries : { id, date, ts, foodId, name, mode: "g" | "u" | "p" (protéines saisies directement), qty, unit, rate, prot }
   settings: { weight, ratio, goals: [{ from: "AAAA-MM-JJ", g }] } — l'historique des objectifs garde l'objectif de chaque jour passé */
const S = { foods: [], entries: [], settings: { weight: null, ratio: 1.6, goals: [] } };
const save = k => DB.set(k, S[k]).catch(e => toast("Sauvegarde impossible : " + e.message));
let pendingReload = false;

/* ---------- Icônes ---------- */
const ic = (d, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  minus: ic('<path d="M5 12h14"/>'),
  chev: ic('<path d="M9.5 5.5L16 12l-6.5 6.5"/>', "chev"),
  left: ic('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
  right: ic('<path d="M9.5 5.5L16 12l-6.5 6.5"/>'),
  search: ic('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
  scan: ic('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M8 8.5v7M11 8.5v7M13.5 8.5v7M16 8.5v7"/>'),
  bolt: ic('<path d="M13 3.5L6 13.5h5.5L10.5 20.5 18 10h-5.5z"/>'),
  share: ic('<path d="M12 15V4M8 7.5L12 3.5l4 4"/><path d="M8 11H6.5A1.5 1.5 0 0 0 5 12.5v6A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-6a1.5 1.5 0 0 0-1.5-1.5H16"/>'),
  download: ic('<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 19.5h14"/>'),
  trash: ic('<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/>'),
};

/* ---------- Outils ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
const addDays = (d, k) => { const x = new Date(d + "T12:00"); x.setDate(x.getDate() + k); return iso(x); };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const fmtLong = d => new Date(d + "T12:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const fmtDM = d => new Date(d + "T12:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
const fmtWeekday = d => new Date(d + "T12:00").toLocaleDateString("fr-FR", { weekday: "long" });
const fmtTime = ts => new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const num = v => (v === "" || v == null) ? NaN : +String(v).replace(",", ".").replace(/\s/g, "");
const fr1 = n => (Math.round(n * 10) / 10).toLocaleString("fr-FR");
const fr0 = n => Math.round(n).toLocaleString("fr-FR");
const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const unitTxt = (q, u) => `${fr1(q)} ${q > 1 && u && !/[sx]$/i.test(u) && !u.includes(" ") ? u + "s" : u}`;
const protFor = (mode, rate, qty) => mode === "g" ? rate * qty / 100 : mode === "u" ? rate * qty : qty;
const foodById = id => S.foods.find(f => f.id === id);
const portionProt = f => protFor(f.mode, f.rate, f.portion);
const qtyText = e => e.mode === "g" ? `${fr1(e.qty)} g` : e.mode === "u" ? unitTxt(e.qty, e.unit) : "saisie directe";
const foodRate = f => f.mode === "g" ? `${fr1(f.rate)} g pour 100 g` : `${fr1(f.rate)} g par ${f.unit}`;
const foodPortion = f => f.mode === "g" ? `portion ${fr1(f.portion)} g` : `habituel : ${unitTxt(f.portion, f.unit)}`;
const byUse = (a, b) => (b.uses || 0) - (a.uses || 0) || (b.last || 0) - (a.last || 0) || a.name.localeCompare(b.name, "fr");

let toastT, toastFn = null;
function toast(msg, action) {
  const t = $("toast");
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button data-act="toast-act">${esc(action.label)}</button>` : ""}`;
  toastFn = action ? action.fn : null; t.hidden = false; clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; toastFn = null; }, action ? 4000 : 2400);
}

/* ---------- Objectif ---------- */
function goalFor(d) {
  const gs = S.settings.goals; if (!gs.length) return 0;
  let g = gs[0].g; for (const x of gs) if (x.from <= d) g = x.g;
  return g;
}
function updateGoal() {
  const { weight: w, ratio: r, goals: gs } = S.settings;
  if (!(w > 0)) return;
  const g = Math.round(w * r), t = today(), last = gs[gs.length - 1];
  if (last && last.g === g) return;
  if (last && last.from === t) last.g = g; else gs.push({ from: t, g });
}
const dayEntries = d => S.entries.filter(e => e.date === d).sort((a, b) => a.ts - b.ts);
const dayTotal = d => S.entries.reduce((a, e) => e.date === d ? a + e.prot : a, 0);
function totalsByDay() {
  const m = new Map();
  for (const e of S.entries) { const x = m.get(e.date) || { tot: 0, n: 0 }; x.tot += e.prot; x.n++; m.set(e.date, x); }
  return m;
}

/* ---------- Anneau de progression ---------- */
let RING_N = 0;
function ringSvg(tot, goal, { r = 100, w = 22, from = null } = {}) {
  const C = 2 * Math.PI * r, s = r * 2 + w, c = s / 2, id = "rg" + (++RING_N);
  const p = goal ? tot / goal : 0, f = from == null ? p : from;
  const part = (x, k) => Math.min(Math.max(x - k, 0), 1);
  const arc = (k, cls, grad) => {
    const x = part(p, k); if (x < .004) return "";
    return `<circle class="r-arc ${cls}" cx="${c}" cy="${c}" r="${r}" stroke="url(#${grad})" stroke-width="${w}"
      stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - x)).toFixed(2)}" style="--from:${(C * (1 - part(f, k))).toFixed(2)}px"/>`;
  };
  return `<svg viewBox="0 0 ${s} ${s}" aria-hidden="true"><defs>
    <linearGradient id="${id}a" x1="${s}" y1="0" x2="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:var(--ring1)"/><stop offset="1" style="stop-color:var(--ring2)"/></linearGradient>
    <linearGradient id="${id}b" x1="${s}" y1="0" x2="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:var(--ring2)"/><stop offset="1" style="stop-color:var(--ring3)"/></linearGradient>
    </defs><circle class="r-track" cx="${c}" cy="${c}" r="${r}" stroke-width="${w}"/>${arc(0, "", id + "a")}${arc(1, "r-lap", id + "b")}</svg>`;
}
const miniRing = (tot, goal) => ringSvg(tot, goal, { r: 12, w: 5 }).replace("<svg ", '<svg class="mini-ring" ');

/* ---------- Composants : feuille et menu de confirmation ---------- */
function resetSheetDrag() { const b = $("modal-box"), w = $("modal"); b.style.transform = b.style.transition = ""; w.style.backgroundColor = w.style.transition = ""; }
function openSheet(html, cls = "") {
  stopCam(); resetSheetDrag();
  const b = $("modal-box"); b.className = "sheet " + cls; b.innerHTML = html;
  $("modal").hidden = false; b.scrollTop = 0; syncLock();
}
function closeSheet() {
  stopCam(); $("modal").hidden = true; $("modal-box").innerHTML = ""; resetSheetDrag(); syncLock();
  if (pendingReload) location.reload();
}
$("modal").addEventListener("click", e => { if (e.target === $("modal")) closeSheet(); });
const head = (title, right = "<span></span>", left = `<button class="btn-text" data-act="close">Annuler</button>`) =>
  `<div class="sheet-head">${left}<h2>${esc(title)}</h2>${right}</div>`;

function ask({ title, message, actions, cancel = "Annuler" }) {
  return new Promise(res => {
    const d = $("dialog");
    d.innerHTML = `<div class="as" role="alertdialog" aria-modal="true">
      <div class="as-group">
        ${title || message ? `<div class="as-head">${title ? `<p class="as-title">${esc(title)}</p>` : ""}${message ? `<p class="as-msg">${esc(message)}</p>` : ""}</div>` : ""}
        ${actions.map((a, k) => `<button class="as-btn ${a.destructive ? "danger" : ""}" data-k="${k}">${esc(a.label)}</button>`).join("")}
      </div>
      <button class="as-btn as-cancel" data-k="-1">${esc(cancel)}</button></div>`;
    d.hidden = false; syncLock();
    const done = v => { d.hidden = true; d.innerHTML = ""; d.onclick = null; syncLock(); res(v); };
    d.onclick = e => {
      const b = e.target.closest("[data-k]");
      if (b) { const k = +b.dataset.k; done(k < 0 ? null : actions[k].value); }
      else if (e.target === d) done(null);
    };
  });
}

/* ---------- Titres ---------- */
let DAY = today(), SEEN_TODAY = today(), TAB = "jour";
const RING_LAST = { day: null, p: 0 };
function dayTitle(d) {
  const t = today();
  return d === t ? "Aujourd'hui" : d === addDays(t, -1) ? "Hier" : cap(fmtWeekday(d));
}
const TITLES = { jour: () => dayTitle(DAY), aliments: () => "Aliments", hist: () => "Historique", reglages: () => "Réglages" };
const largeTitle = (eyebrow, title, side = "") =>
  `<header class="lt"><p class="eyebrow">${esc(eyebrow)}</p><div class="lt-row"><h1>${esc(title)}</h1>${side}</div></header>`;

/* ---------- Rendu : Jour ---------- */
function renderJour() {
  const d = DAY, t = today(), list = dayEntries(d), tot = list.reduce((a, e) => a + e.prot, 0), goal = goalFor(d);
  const isToday = d === t, p = goal ? tot / goal : 0;
  const from = RING_LAST.day === d ? RING_LAST.p : 0;
  RING_LAST.day = d; RING_LAST.p = p;
  const eyebrow = d === t || d === addDays(t, -1) ? fmtLong(d) : fmtDM(d) + (d.slice(0, 4) !== t.slice(0, 4) ? " " + d.slice(0, 4) : "");
  const nav = `<div class="day-nav">
      <button class="icon-btn lg" data-act="day" data-k="-1" aria-label="Jour précédent">${I.left}</button>
      <button class="icon-btn lg" data-act="day" data-k="1" aria-label="Jour suivant" ${isToday ? "disabled" : ""}>${I.right}</button></div>`;

  let msg;
  if (!goal) msg = `<p class="ring-msg">Pas encore d'objectif<span>Tes ajouts sont quand même comptés</span></p>`;
  else if (tot >= goal) msg = `<p class="ring-msg ok">Objectif atteint<span>${tot - goal >= .5 ? `+${fr0(tot - goal)} g au-dessus de l'objectif` : "Pile dans le mille"}</span></p>`;
  else if (!tot) msg = `<p class="ring-msg">${isToday ? "C'est parti" : "Rien de noté ce jour-là"}<span>Objectif : ${fr0(goal)} g de protéines</span></p>`;
  else msg = `<p class="ring-msg">Encore ${fr0(goal - tot)} g<span>${Math.floor(p * 100)} % de l'objectif</span></p>`;

  const banner = !(S.settings.weight > 0) ? `<div class="banner"><div><b>Ton objectif</b><span>Entre ton poids pour le calculer.</span></div><button class="btn-text bold" data-act="tab" data-tab="reglages">Régler</button></div>` : "";

  const quick = [...S.foods].sort(byUse).slice(0, 6);
  const tiles = quick.length ? `<p class="sh">Ajout rapide</p><div class="tiles">${quick.map(f => `
      <button class="tile" data-act="quick" data-id="${f.id}" aria-label="Ajouter ${esc(f.name)}">
        <span class="tile-name">${esc(f.name)}</span>
        <span class="tile-foot"><span class="tile-sub">${f.mode === "g" ? fr1(f.portion) + " g" : esc(unitTxt(f.portion, f.unit))}</span>
        <span class="tile-plus">+${fr1(portionProt(f))} g</span></span></button>`).join("")}</div>` : "";

  const journal = list.length
    ? `<ul class="group">${list.map(e => `<li><button class="row row-btn" data-act="entry" data-id="${e.id}">
        <span class="row-main"><span class="row-name">${esc(e.name)}</span><span class="row-sub">${esc(qtyText(e))} · ${fmtTime(e.ts)}</span></span>
        <span class="row-val">${fr1(e.prot)}<small>g</small></span></button></li>`).join("")}</ul>`
    : `<p class="empty">${isToday ? "Rien pour l'instant. Ajoute ce que tu manges au fil de la journée." : "Aucun aliment ce jour-là."}</p>`;

  $("v-jour").innerHTML = `${largeTitle(eyebrow, dayTitle(d), nav)}
    ${banner}
    <div class="card ring-card">
      <div class="ring">${ringSvg(tot, goal, { from })}
        <div class="ring-in"><span class="ring-val">${fr0(tot)}<small>g</small></span><span class="ring-goal">${goal ? `sur ${fr0(goal)} g` : "de protéines"}</span></div></div>
      ${msg}
    </div>
    <div class="btns">
      <button class="btn btn-primary" data-act="picker">${I.plus}Ajouter</button>
      <button class="btn btn-tinted" data-act="scan">${I.scan}Scanner</button>
    </div>
    ${tiles}
    <div class="sh sh-row"><span>Journal</span>${list.length ? `<span class="num">${plural(list.length, "aliment")}</span>` : ""}</div>
    ${journal}`;
}

/* ---------- Rendu : Aliments ---------- */
let AL_Q = "";
function foodRows(list, act) {
  return `<ul class="group">${list.map(f => `<li><button class="row row-btn" data-act="${act}" data-id="${f.id}">
    <span class="row-main"><span class="row-name">${esc(f.name)}</span>
    <span class="row-sub">${f.brand ? esc(f.brand) + " · " : ""}${esc(foodRate(f))} · ${esc(foodPortion(f))}</span></span>
    ${act === "pick" ? `<span class="row-val accent">${fr1(portionProt(f))}<small>g</small></span>` : I.chev}</button></li>`).join("")}</ul>`;
}
const filterFoods = q => { const n = norm(q).trim(); return n ? S.foods.filter(f => norm(f.name + " " + (f.brand || "")).includes(n)) : S.foods; };
function renderAliments() {
  const n = S.foods.length;
  const side = `<button class="icon-btn lg" data-act="food-new" aria-label="Nouvel aliment">${I.plus}</button>`;
  $("v-aliments").innerHTML = `${largeTitle(n ? plural(n, "aliment") : "Ta liste", "Aliments", side)}
    ${n ? `<label class="search">${I.search}<input id="al-q" type="search" placeholder="Rechercher" autocomplete="off" value="${esc(AL_Q)}"></label>
      <div id="al-list"></div>
      <p class="footnote">Touche un aliment pour le modifier. Les plus utilisés apparaissent en ajout rapide sur l'écran du jour.</p>`
    : `<div class="card"><p class="muted" style="margin:0">Enregistre ici ce que tu manges souvent, une seule fois. Ensuite tu n'auras plus qu'à toucher l'aliment pour l'ajouter à ta journée.</p></div>`}
    <div class="btns">
      <button class="btn btn-primary" data-act="food-new">${I.plus}Nouveau</button>
      <button class="btn btn-tinted" data-act="scan">${I.scan}Scanner</button>
    </div>`;
  if (n) drawAlList();
}
function drawAlList() {
  const el = $("al-list"); if (!el) return;
  const list = [...filterFoods(AL_Q)].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  el.innerHTML = list.length ? foodRows(list, "food-edit") : `<p class="empty">Aucun aliment ne correspond.</p>`;
}

/* ---------- Rendu : Historique ---------- */
let H_RANGE = 7;
function renderHist() {
  const t = today(), T = totalsByDay(), n = H_RANGE;
  const days = Array.from({ length: n }, (_, i) => addDays(t, i - n + 1));
  const first = [...T.keys()].sort()[0];
  const tracked = days.filter(d => first && d >= first);
  const withData = days.filter(d => T.has(d));
  const avg = withData.length ? withData.reduce((a, d) => a + T.get(d).tot, 0) / withData.length : 0;
  const hit = d => goalFor(d) > 0 && (T.get(d)?.tot || 0) >= goalFor(d);
  const reached = tracked.filter(hit).length;
  let streak = 0, d = hit(t) ? t : addDays(t, -1);
  while (hit(d)) { streak++; d = addDays(d, -1); }

  const all = [...T.keys()].sort().reverse().slice(0, 60);
  const listHtml = all.length ? `<p class="sh">Jours</p><ul class="group rings">${all.map(x => {
      const v = T.get(x), g = goalFor(x);
      return `<li><button class="row row-btn" data-act="goto-day" data-d="${x}">${miniRing(v.tot, g)}
        <span class="row-main"><span class="row-name">${esc(cap(fmtLong(x)))}</span><span class="row-sub">${plural(v.n, "aliment")}</span></span>
        <span class="row-val">${fr0(v.tot)}<small>${g ? ` / ${fr0(g)} g` : " g"}</small></span></button></li>`;
    }).join("")}</ul>` : `<p class="empty">Ton historique apparaîtra ici dès ton premier aliment noté.</p>`;

  $("v-hist").innerHTML = `${largeTitle(`${n} derniers jours`, "Historique")}
    <div class="card">
      <div class="seg" role="group" aria-label="Période">
        <button data-act="range" data-n="7" aria-pressed="${n === 7}">7 jours</button>
        <button data-act="range" data-n="30" aria-pressed="${n === 30}">30 jours</button>
      </div>
      <div class="bars">${barsSvg(days, T)}</div>
      <div class="metric-row">
        <div><p class="label">Moyenne</p><p class="value">${withData.length ? fr0(avg) : "—"}<small>g</small></p></div>
        <div><p class="label">Objectif</p><p class="value">${reached}<small>/ ${tracked.length || n} j</small></p></div>
        <div><p class="label">Série</p><p class="value">${streak}<small>j</small></p></div>
      </div>
    </div>
    <p class="footnote">La moyenne compte seulement les jours où tu as noté quelque chose. La série, ce sont les jours d'affilée avec l'objectif atteint.</p>
    ${listHtml}`;
}
function barsSvg(days, T) {
  const W = 340, H = 158, top = 18, bot = 22, n = days.length, t = today();
  const gl = goalFor(t);
  const max = Math.max(gl * 1.2, ...days.map(d => T.get(d)?.tot || 0), 20);
  const step = W / n, bw = Math.min(28, step * .64), base = H - bot;
  const y = v => top + (base - top) * (1 - v / max);
  let out = `<line class="grid" x1="0" x2="${W}" y1="${base}" y2="${base}"/>`;
  if (gl) out += `<line class="goal-line" x1="0" x2="${W}" y1="${y(gl).toFixed(1)}" y2="${y(gl).toFixed(1)}"/>`;
  days.forEach((d, i) => {
    const v = T.get(d)?.tot || 0, g = goalFor(d), x = i * step + (step - bw) / 2, cx = i * step + step / 2;
    if (v > 0) {
      const h = Math.max(3, base - y(v));
      out += `<rect class="bar ${g && v >= g ? "ok" : ""} ${d === t ? "today" : ""}" x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(bw / 2, 5).toFixed(1)}"/>`;
      if (n <= 7) out += `<text class="bar-val" x="${cx.toFixed(1)}" y="${(base - h - 5).toFixed(1)}" text-anchor="middle">${fr0(v)}</text>`;
    }
    const lab = n <= 7 ? new Date(d + "T12:00").toLocaleDateString("fr-FR", { weekday: "narrow" }) : ((n - 1 - i) % 5 === 0 ? String(+d.slice(8)) : "");
    if (lab) out += `<text class="axis" x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">${lab}</text>`;
    out += `<rect class="hit" data-act="goto-day" data-d="${d}" x="${(i * step).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Protéines par jour">${out}</svg>`;
}

/* ---------- Rendu : Réglages ---------- */
function renderReglages() {
  const { weight: w, ratio: r } = S.settings, g = goalFor(today());
  $("v-reglages").innerHTML = `${largeTitle("Ton objectif", "Réglages")}
    <div class="card goal-card">
      <p class="label">Objectif quotidien</p>
      <p class="goal-val">${w > 0 ? fr0(g) : "—"}<small> g</small></p>
      <p class="muted" style="margin:0">${w > 0 ? `${fr1(w)} kg × ${fr1(r)} g par kilo` : "Entre ton poids juste en dessous"}</p>
    </div>
    <ul class="group">
      <li><label class="row"><span class="row-label">Poids</span>
        <input id="st-weight" class="row-input" inputmode="decimal" placeholder="Ex. 70" value="${w > 0 ? fr1(w) : ""}" enterkeyhint="done"><span class="row-unit">kg</span></label></li>
      <li><div class="row"><span class="row-label">Protéines par kilo</span><span style="flex:1"></span>
        <div class="stepper">
          <button class="icon-btn" data-act="ratio" data-k="-1" aria-label="Diminuer" ${r <= .8 ? "disabled" : ""}>${I.minus}</button>
          <b>${fr1(r)}</b>
          <button class="icon-btn" data-act="ratio" data-k="1" aria-label="Augmenter" ${r >= 3 ? "disabled" : ""}>${I.plus}</button>
        </div></div></li>
    </ul>
    <p class="footnote">Pour quelqu'un qui fait de la muscu, on vise souvent entre 1,6 et 2 g par kilo de poids de corps. Si tu changes ces réglages, les jours passés gardent l'objectif qu'ils avaient.</p>
    <p class="sh">Tes données</p>
    <ul class="group">
      <li><button class="row row-btn" data-act="export"><span class="row-main accent">Exporter une sauvegarde</span>${I.share}</button></li>
      <li><label class="row row-btn"><span class="row-main accent">Importer une sauvegarde</span>${I.download}
        <input id="st-import" type="file" accept="application/json,.json" hidden></label></li>
      <li><button class="row row-btn" data-act="wipe"><span class="row-main danger">Tout effacer</span></button></li>
    </ul>
    <p class="footnote">Tout reste sur ton iPhone. Seule la recherche d'un code-barres inconnu passe par Open Food Facts.</p>
    <p class="muted center" style="margin-top:12px">Prot'Claude · version ${APP_VERSION}<br>Infos produits : Open Food Facts (licence ODbL)</p>`;
}

/* ---------- Ajout : choix de l'aliment ---------- */
let PK_Q = "";
function openPicker() {
  PK_Q = "";
  openSheet(`${head("Ajouter", `<button class="icon-btn lg" data-act="scan" aria-label="Scanner">${I.scan}</button>`)}
    <label class="search">${I.search}<input id="pk-q" type="search" placeholder="Rechercher un aliment" autocomplete="off"></label>
    <div id="pk-list"></div>`, "tall");
  drawPickList();
}
function drawPickList() {
  const el = $("pk-list"); if (!el) return;
  const list = [...filterFoods(PK_Q)].sort(byUse), q = PK_Q.trim();
  el.innerHTML = `${list.length ? foodRows(list, "pick")
      : `<p class="empty">${S.foods.length ? "Aucun aliment ne correspond." : "Ta liste est vide pour l'instant : enregistre ton premier aliment ou scanne un produit."}</p>`}
    <ul class="group" style="margin-top:12px">
      <li><button class="row row-btn accent" data-act="food-new">${I.plus}<span class="row-main"><span class="row-name">${q ? `Créer « ${esc(q)} »` : "Nouvel aliment"}</span></span></button></li>
      <li><button class="row row-btn accent" data-act="scan">${I.scan}<span class="row-main">Scanner un produit</span></button></li>
      <li><button class="row row-btn accent" data-act="quick-p">${I.bolt}<span class="row-main"><span class="row-name">Saisie directe</span><span class="row-sub">Juste un nombre de grammes de protéines</span></span></button></li>
    </ul>`;
}

/* ---------- Ajout : quantité ---------- */
let QS = null;
function openQty({ food, entry, direct }) {
  if (entry) {
    QS = { entryId: entry.id, foodId: entry.foodId, name: entry.name, mode: entry.mode, rate: entry.rate, unit: entry.unit, qty: entry.qty, date: entry.date };
    const f = entry.foodId && foodById(entry.foodId); QS.portion = f ? f.portion : entry.qty;
  } else if (food) {
    QS = { foodId: food.id, name: food.name, mode: food.mode, rate: food.rate, unit: food.unit, qty: food.portion, portion: food.portion, date: DAY };
  } else if (direct) {
    QS = { name: "", mode: "p", qty: "", portion: 25, date: DAY };
  }
  const m = QS.mode, t = today();
  let chips = [];
  if (m === "g") chips = [...new Set([QS.portion / 2, QS.portion, 100, QS.portion * 2].map(v => Math.round(v * 10) / 10))].filter(v => v > 0).sort((a, b) => a - b).map(v => [v, fr1(v) + " g"]);
  else if (m === "u") chips = [[.5, "½"], [1, "1"], [2, "2"], [3, "3"]];
  else chips = [[10, "10 g"], [20, "20 g"], [25, "25 g"], [30, "30 g"]];
  const f = QS.foodId && foodById(QS.foodId);
  openSheet(`${head(m === "p" ? "Saisie directe" : QS.name, `<button class="btn-text bold" data-act="qty-save">${QS.entryId ? "OK" : "Ajouter"}</button>`)}
    <div class="card qty-card">
      <p class="label">${m === "p" ? "Protéines" : "Quantité"}</p>
      <div class="qty-line"><input id="qs-qty" class="qty-in" inputmode="decimal" value="${QS.qty === "" ? "" : fr1(QS.qty)}" placeholder="0" enterkeyhint="done" aria-label="Quantité"><span class="qty-unit" id="qs-unit"></span></div>
      ${m === "p" ? "" : `<p class="qty-res" id="qs-res"></p>`}
      <div class="chips">${chips.map(([v, l]) => `<button class="chip" data-act="qty-chip" data-v="${v}">${l}</button>`).join("")}</div>
    </div>
    <ul class="group">
      ${m === "p" ? `<li><label class="row"><span class="row-label">Nom</span><input id="qs-name" class="row-input" placeholder="Facultatif" value="${esc(QS.name === "Saisie directe" ? "" : QS.name)}"></label></li>` : ""}
      <li><label class="row"><span class="row-label">Jour</span><input id="qs-date" type="date" class="row-input" max="${t}" value="${QS.date}"></label></li>
    </ul>
    ${m !== "p" ? `<p class="footnote">${esc(m === "g" ? `${fr1(QS.rate)} g de protéines pour 100 g` : `${fr1(QS.rate)} g de protéines par ${QS.unit}`)}${f ? "" : QS.entryId ? " · aliment supprimé de ta liste" : ""}</p>` : ""}
    ${QS.entryId ? `<button class="btn btn-danger" data-act="qty-del">${I.trash}Retirer de la journée</button>` : ""}`);
  drawQty();
}
function drawQty() {
  const el = $("qs-qty"); if (!el) return;
  const q = num(el.value), u = $("qs-unit"), r = $("qs-res");
  el.style.width = Math.max(1.6, el.value.length * .62 + .5) + "em";
  if (u) u.textContent = QS.mode === "u" ? (q > 1 && !/[sx]$/i.test(QS.unit) && !QS.unit.includes(" ") ? QS.unit + "s" : QS.unit) : "g";
  if (r) r.textContent = q > 0 ? `= ${fr1(protFor(QS.mode, QS.rate, q))} g de protéines` : "Indique une quantité";
}
function addEntry(food, qty, date) {
  const e = { id: uid(), date, ts: Date.now(), foodId: food.id, name: food.name, mode: food.mode, qty, unit: food.unit || "", rate: food.rate, prot: protFor(food.mode, food.rate, qty) };
  S.entries.push(e); food.uses = (food.uses || 0) + 1; food.last = Date.now();
  save("entries"); save("foods");
  return e;
}
function undoAdd(e) {
  S.entries = S.entries.filter(x => x.id !== e.id);
  const f = e.foodId && foodById(e.foodId); if (f && f.uses) { f.uses--; save("foods"); }
  save("entries"); renderAll();
}
function saveQty() {
  const q = num($("qs-qty").value), date = $("qs-date").value || DAY;
  if (!(q > 0)) { toast("Indique une quantité"); return; }
  if (date > today()) { toast("Ce jour n'est pas encore arrivé"); return; }
  const prot = protFor(QS.mode, QS.rate, q);
  let e;
  if (QS.entryId) {
    e = S.entries.find(x => x.id === QS.entryId); if (!e) return closeSheet();
    Object.assign(e, { qty: q, date, prot });
    if (QS.mode === "p") e.name = $("qs-name").value.trim() || "Saisie directe";
    save("entries"); closeSheet(); renderAll(); toast("Modifié");
    return;
  }
  if (QS.mode === "p") {
    e = { id: uid(), date, ts: Date.now(), foodId: null, name: $("qs-name").value.trim() || "Saisie directe", mode: "p", qty: q, unit: "", rate: 1, prot };
    S.entries.push(e); save("entries");
  } else {
    const f = foodById(QS.foodId); if (!f) return closeSheet();
    e = addEntry(f, q, date);
  }
  closeSheet(); renderAll();
  toast(`+${fr1(prot)} g${date !== DAY ? " · " + fmtDM(date) : ""}`, { label: "Annuler", fn: () => undoAdd(e) });
}
function quickAdd(id) {
  const f = foodById(id); if (!f) return;
  const e = addEntry(f, f.portion, DAY); renderAll();
  toast(`${f.name} · +${fr1(e.prot)} g`, { label: "Annuler", fn: () => undoAdd(e) });
}

/* ---------- Fiche aliment ---------- */
let FF = null;
function openFood(food, prefill = {}, then = "") {
  FF = food ? { ...food, edit: true } : { name: "", brand: "", mode: "g", rate: "", unit: "", portion: "", barcode: "", ...prefill, edit: false };
  FF.then = then;
  drawFood();
}
function drawFood() {
  const f = FF, g = f.mode === "g", v = x => x === "" || x == null || Number.isNaN(x) ? "" : fr1(x);
  openSheet(`${head(f.edit ? "Aliment" : "Nouvel aliment", `<button class="btn-text bold" data-act="ff-save">OK</button>`)}
    ${f.warn ? `<p class="warn">${esc(f.warn)}</p>` : ""}
    <ul class="group">
      <li><label class="row"><span class="row-label">Nom</span><input id="ff-name" class="row-input" placeholder="Ex. Skyr nature" value="${esc(f.name)}" autocomplete="off"></label></li>
      <li><label class="row"><span class="row-label">Marque</span><input id="ff-brand" class="row-input" placeholder="Facultatif" value="${esc(f.brand)}" autocomplete="off"></label></li>
    </ul>
    <p class="sh">Protéines</p>
    <div class="seg seg-lg" role="group" aria-label="Façon de compter">
      <button data-act="ff-mode" data-m="g" aria-pressed="${g}">Pour 100 g</button>
      <button data-act="ff-mode" data-m="u" aria-pressed="${!g}">Par unité</button>
    </div>
    <ul class="group">
      ${g ? "" : `<li><label class="row"><span class="row-label">Unité</span><input id="ff-unit" class="row-input" placeholder="œuf, pot, dose…" value="${esc(f.unit)}" autocomplete="off"></label></li>`}
      <li><label class="row"><span class="row-label">${g ? "Pour 100 g" : "Par unité"}</span><input id="ff-rate" class="row-input" inputmode="decimal" placeholder="0" value="${v(f.rate)}"><span class="row-unit">g</span></label></li>
      <li><label class="row"><span class="row-label">${g ? "Portion habituelle" : "Nombre habituel"}</span><input id="ff-portion" class="row-input" inputmode="decimal" placeholder="${g ? "100" : "1"}" value="${v(f.portion)}">${g ? `<span class="row-unit">g</span>` : ""}</label></li>
    </ul>
    <p class="footnote">${g ? "Sur l'étiquette : ligne « Protéines », colonne « pour 100 g ». La portion, c'est ce que tu manges d'habitude en une fois."
      : "Pratique pour ce qui se compte : un œuf, un pot, une dose de whey… Le nombre habituel est ajouté en un geste."}</p>
    <p class="sh">Code-barres</p>
    <ul class="group">
      <li><label class="row"><span class="row-label">Code</span><input id="ff-code" class="row-input" inputmode="numeric" placeholder="Facultatif" value="${esc(f.barcode)}" autocomplete="off"></label></li>
    </ul>
    <p class="footnote">${f.off ? "Infos récupérées sur Open Food Facts : jette un œil à l'étiquette pour vérifier." : "Avec le code, ce produit sera reconnu au scan, même sans réseau."}</p>
    ${f.edit ? `<button class="btn btn-danger" data-act="ff-del">${I.trash}Supprimer l'aliment</button>` : ""}`);
}
function readFood() {
  const g = id => $(id) ? $(id).value : null;
  FF.name = g("ff-name"); FF.brand = g("ff-brand"); FF.barcode = g("ff-code");
  if (g("ff-unit") !== null) FF.unit = g("ff-unit");
  const r = num(g("ff-rate")), p = num(g("ff-portion"));
  FF.rate = Number.isNaN(r) ? "" : r; FF.portion = Number.isNaN(p) ? "" : p;
}
function normCode(raw) {
  let c = String(raw || "").replace(/\D/g, "");
  if (c.length === 12) c = "0" + c;
  return c.length === 8 || c.length === 13 ? c : "";
}
function validEan(c) {
  if (!c) return false;
  const d = c.split("").map(Number), last = d.pop();
  const s = d.reverse().reduce((a, x, i) => a + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - s % 10) % 10 === last;
}
async function saveFood() {
  readFood();
  const f = FF, name = f.name.trim(), g = f.mode === "g";
  if (!name) return toast("Donne un nom à l'aliment");
  if (!(f.rate >= 0) || f.rate === "") return toast("Indique les protéines");
  if (g && f.rate > 100) return toast("Pas plus de 100 g pour 100 g");
  const unit = g ? "" : (f.unit || "").trim() || "portion";
  const portion = f.portion > 0 ? f.portion : g ? 100 : 1;
  let code = "";
  if ((f.barcode || "").trim()) {
    code = normCode(f.barcode);
    if (!code) return toast("Code-barres : 8 ou 13 chiffres");
    const other = S.foods.find(x => x.barcode === code && x.id !== f.id);
    if (other) return toast(`Ce code est déjà pris par « ${other.name} »`);
  }
  const data = { name, brand: (f.brand || "").trim(), mode: f.mode, rate: f.rate, unit, portion, barcode: code };
  let food;
  if (f.edit) { food = foodById(f.id); Object.assign(food, data); }
  else { food = { id: uid(), ...data, uses: 0, last: 0, created: Date.now() }; S.foods.push(food); }
  await save("foods");
  renderAll();
  if (FF.then === "add") openQty({ food });
  else { closeSheet(); toast(f.edit ? "Aliment modifié" : "Aliment enregistré"); }
}
async function deleteFood() {
  const f = foodById(FF.id); if (!f) return closeSheet();
  const ok = await ask({ title: `Supprimer « ${f.name} » ?`, message: "Les jours où tu l'as déjà noté ne changent pas.", actions: [{ label: "Supprimer l'aliment", value: true, destructive: true }] });
  if (!ok) return;
  S.foods = S.foods.filter(x => x.id !== f.id); save("foods"); closeSheet(); renderAll(); toast("Aliment supprimé");
}

/* ---------- Scanner ---------- */
const SCAN = { stream: null, timer: 0, det: null, reader: null, hints: null, cv: null, flip: false, last: "", done: false, run: 0 };
function openScan() {
  openSheet(`${head("Scanner")}
    <div class="cam" id="cam"><video id="cam-v" playsinline muted autoplay></video><div class="cam-guide"></div><div class="cam-msg" id="cam-msg" hidden></div></div>
    <p class="footnote center" id="cam-tip" style="margin-top:0">Place le code-barres dans le cadre.</p>
    <div id="scan-state"></div>
    <p class="sh">Ou tape le code</p>
    <div class="manual"><input id="scan-code" inputmode="numeric" placeholder="13 chiffres" autocomplete="off" enterkeyhint="search" aria-label="Code-barres"><button class="btn btn-tinted" data-act="scan-go">Chercher</button></div>`, "tall");
  startCam();
}
function camMsg(t) { const m = $("cam-msg"); if (m) { m.textContent = t; m.hidden = false; } }
async function startCam() {
  const run = ++SCAN.run;
  SCAN.done = false; SCAN.last = "";
  $("cam")?.classList.remove("hit");
  if (!navigator.mediaDevices?.getUserMedia) return camMsg("La caméra n'est pas accessible ici. Tape le code juste en dessous.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    return camMsg(e && e.name === "NotAllowedError" ? "Accès à la caméra refusé. Tu peux taper le code juste en dessous." : "Caméra indisponible. Tape le code juste en dessous.");
  }
  if (run !== SCAN.run || !$("cam-v")) { stream.getTracks().forEach(t => t.stop()); return; }
  SCAN.stream = stream;
  const v = $("cam-v"); v.srcObject = stream;
  try { await v.play(); } catch (e) {}
  await initDecoder();
  if (!SCAN.det && !SCAN.reader) return camMsg("Le lecteur de code-barres n'a pas pu démarrer. Tape le code juste en dessous.");
  loop();
}
function stopCam() {
  SCAN.run++; clearTimeout(SCAN.timer); SCAN.done = true;
  if (SCAN.stream) { SCAN.stream.getTracks().forEach(t => t.stop()); SCAN.stream = null; }
  const v = $("cam-v"); if (v) v.srcObject = null;
}
async function initDecoder() {
  if (SCAN.det || SCAN.reader) return;
  if ("BarcodeDetector" in window) {
    try {
      const have = await BarcodeDetector.getSupportedFormats();
      const want = ["ean_13", "ean_8", "upc_a", "upc_e"].filter(x => have.includes(x));
      if (want.length) { SCAN.det = new BarcodeDetector({ formats: want }); return; }
    } catch (e) {}
  }
  if (window.ZX) {
    const h = new Map();
    h.set(ZX.DecodeHintType.TRY_HARDER, true);
    h.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E]);
    SCAN.hints = h; SCAN.reader = new ZX.MultiFormatUPCEANReader(h);
  }
}
function loop() {
  clearTimeout(SCAN.timer);
  if (!SCAN.stream || SCAN.done) return;
  const run = SCAN.run;
  SCAN.timer = setTimeout(async () => {
    let code = null;
    try { code = await readFrame(); } catch (e) {}
    if (run !== SCAN.run) return;
    if (code) found(code); else loop();
  }, 80);
}
async function readFrame() {
  const v = $("cam-v"); if (!v || v.readyState < 2 || !v.videoWidth) return null;
  if (SCAN.det) { const r = await SCAN.det.detect(v); return r.length ? r[0].rawValue : null; }
  // Partie de l'image réellement visible (la vidéo est recadrée pour remplir la zone)
  const vw = v.videoWidth, vh = v.videoHeight, box = v.getBoundingClientRect();
  const ca = box.width / box.height || 4 / 3;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (vw / vh > ca) { sw = vh * ca; sx = (vw - sw) / 2; } else { sh = vw / ca; sy = (vh - sh) / 2; }
  SCAN.flip = !SCAN.flip;   // une image sur deux : on essaie aussi le code tenu à la verticale
  const [rx, ry, rw, rh] = SCAN.flip ? [sx + sw * .28, sy, sw * .44, sh] : [sx + sw * .04, sy + sh * .18, sw * .92, sh * .64];
  const k = Math.min(1, 900 / Math.max(rw, rh)), w = Math.round(rw * k), h = Math.round(rh * k);
  const cv = SCAN.cv || (SCAN.cv = document.createElement("canvas"));
  if (SCAN.flip) { cv.width = h; cv.height = w; } else { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (SCAN.flip) { ctx.save(); ctx.translate(h, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(v, rx, ry, rw, rh, 0, 0, w, h); ctx.restore(); }
  else ctx.drawImage(v, rx, ry, rw, rh, 0, 0, w, h);
  return decodeCanvas(cv);
}
function decodeCanvas(cv) {
  const W = cv.width, H = cv.height, d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const lum = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  try {
    const bmp = new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.RGBLuminanceSource(lum, W, H)));
    return SCAN.reader.decode(bmp, SCAN.hints).getText();
  } catch (e) { return null; } finally { try { SCAN.reader.reset(); } catch (e) {} }
}
function found(raw) {
  const code = normCode(raw);
  if (!code || !validEan(code)) return loop();
  // Avec le lecteur intégré, on attend deux lectures identiques pour éviter les erreurs
  if (!SCAN.det && code !== SCAN.last) { SCAN.last = code; return loop(); }
  SCAN.done = true;
  $("cam")?.classList.add("hit");
  try { navigator.vibrate?.(40); } catch (e) {}
  setTimeout(() => lookup(code), 220);
}
function scanState(html) {
  const s = $("scan-state"); if (!s) return;
  s.innerHTML = html ? `<div class="scan-state">${html}</div>` : "";
  const hideCam = !!html;
  if ($("cam")) $("cam").hidden = hideCam;
  if ($("cam-tip")) $("cam-tip").hidden = hideCam;
}
async function lookup(code) {
  stopCam();
  const local = S.foods.find(f => f.barcode === code);
  if (local) { openQty({ food: local }); return; }
  scanState(`<div class="spinner" role="progressbar" aria-label="Recherche"></div><p class="muted">Recherche du produit ${esc(code)}…</p>`);
  const run = SCAN.run;
  let res;
  try { res = await offFetch(code); }
  catch (e) {
    if (run !== SCAN.run) return;
    scanState(`<p class="big">Pas de réseau</p><p class="muted">Le produit ${esc(code)} n'est pas encore dans ta liste, et il faut du réseau pour le chercher. Tu peux l'enregistrer à la main avec l'étiquette.</p>
      <div class="btns" style="width:100%"><button class="btn btn-primary" data-act="food-code" data-code="${code}">Créer l'aliment</button><button class="btn btn-tinted" data-act="scan-retry">Réessayer</button></div>`);
    return;
  }
  if (run !== SCAN.run) return;
  if (!res) {
    scanState(`<p class="big">Produit inconnu</p><p class="muted">Open Food Facts ne connaît pas le code ${esc(code)}. Enregistre-le à la main : la prochaine fois, il sera reconnu tout de suite.</p>
      <div class="btns" style="width:100%"><button class="btn btn-primary" data-act="food-code" data-code="${code}">Créer l'aliment</button><button class="btn btn-tinted" data-act="scan-retry">Rescanner</button></div>`);
    return;
  }
  openFood(null, res, "add");
}
async function offFetch(code) {
  if (navigator.onLine === false) throw new Error("hors ligne");
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const fields = "product_name,product_name_fr,generic_name_fr,brands,nutriments,serving_quantity";
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${fields}`, { signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j.status !== 1 || !j.product) return null;
    const p = j.product, n = p.nutriments || {}, sq = num(p.serving_quantity);
    let rate = num(n.proteins_100g);
    if (Number.isNaN(rate) && num(n.proteins_serving) >= 0 && sq > 0) rate = num(n.proteins_serving) / sq * 100;
    const name = (p.product_name_fr || p.product_name || p.generic_name_fr || "").trim();
    const warn = Number.isNaN(rate) ? "Open Food Facts ne donne pas les protéines de ce produit : complète avec l'étiquette." : !name ? "Le produit n'a pas de nom sur Open Food Facts : donne-lui en un." : "";
    return {
      name, brand: (p.brands || "").split(",")[0].trim(), mode: "g",
      rate: Number.isNaN(rate) ? "" : Math.round(rate * 10) / 10,
      portion: sq > 0 && sq < 3000 ? Math.round(sq * 10) / 10 : 100,
      barcode: code, off: true, warn,
    };
  } finally { clearTimeout(tm); }
}

/* ---------- Sauvegarde ---------- */
async function exportData() {
  const data = { app: "protclaude", version: 1, exportedAt: new Date().toISOString(), foods: S.foods, entries: S.entries, settings: S.settings };
  const name = `protclaude-sauvegarde-${today()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: "application/json" });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Sauvegarde Prot'Claude" }); return; } } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove();
}
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "protclaude") throw new Error("ce fichier n'est pas une sauvegarde de Prot'Claude");
    const merge = (cur, inc) => { const m = new Map(cur.map(x => [x.id, x])); (inc || []).forEach(x => m.set(x.id, x)); return [...m.values()]; };
    S.foods = merge(S.foods, data.foods); S.entries = merge(S.entries, data.entries);
    const st = data.settings || {};
    if (!(S.settings.weight > 0) && st.weight > 0) { S.settings.weight = st.weight; S.settings.ratio = st.ratio || S.settings.ratio; }
    const gm = new Map([...(st.goals || []), ...S.settings.goals].map(x => [x.from, x]));
    S.settings.goals = [...gm.values()].sort((a, b) => a.from.localeCompare(b.from));
    await Promise.all([save("foods"), save("entries"), save("settings")]);
    renderAll(); toast(`Import terminé : ${plural((data.entries || []).length, "ajout")}`);
  } catch (e) { toast("Import impossible : " + e.message); }
}
async function wipe() {
  const ok = await ask({ title: "Tout effacer ?", message: "Tes aliments, ton historique et tes réglages seront supprimés de ce téléphone.", actions: [{ label: "Tout effacer", value: true, destructive: true }] });
  if (!ok) return;
  S.foods = []; S.entries = []; S.settings = { weight: null, ratio: 1.6, goals: [] };
  await Promise.all([save("foods"), save("entries"), save("settings")]);
  renderAll(); toast("Données effacées");
}

/* ---------- Événements ---------- */
document.addEventListener("input", e => {
  const id = e.target.id;
  if (id === "pk-q") { PK_Q = e.target.value; drawPickList(); }
  else if (id === "al-q") { AL_Q = e.target.value; drawAlList(); }
  else if (id === "qs-qty") drawQty();
});
document.addEventListener("change", e => {
  const id = e.target.id;
  if (id === "st-weight") {
    const w = num(e.target.value);
    S.settings.weight = w > 0 && w < 400 ? Math.round(w * 10) / 10 : null;
    updateGoal(); save("settings"); renderAll();
  } else if (id === "st-import" && e.target.files[0]) { importData(e.target.files[0]); e.target.value = ""; }
});
document.addEventListener("focusin", e => { if (e.target.classList?.contains("qty-in")) setTimeout(() => e.target.select(), 0); });
document.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const id = e.target.id;
  if (id === "qs-qty") { e.preventDefault(); saveQty(); }
  else if (id === "scan-code") { e.preventDefault(); manualCode(); }
  else if (id === "st-weight") e.target.blur();
});
function manualCode() {
  const raw = $("scan-code").value, code = normCode(raw);
  if (!code) return toast("Il faut 8 ou 13 chiffres");
  if (!validEan(code)) return toast("Ce code ne semble pas valide, vérifie les chiffres");
  $("scan-code").blur(); lookup(code);
}

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
  const a = b.dataset.act;
  switch (a) {
    case "tab": if (!$("modal").hidden) closeSheet(); showTab(b.dataset.tab); break;
    case "close": closeSheet(); break;
    case "toast-act": { const fn = toastFn; $("toast").hidden = true; toastFn = null; fn && fn(); break; }
    case "day": {
      const nd = addDays(DAY, +b.dataset.k); if (nd > today()) break;
      DAY = nd; renderJour(); onScroll(); $("nav-title").textContent = TITLES.jour(); break;
    }
    case "goto-day": DAY = b.dataset.d; renderJour(); showTab("jour"); break;
    case "picker": openPicker(); break;
    case "pick": { const f = foodById(b.dataset.id); if (f) openQty({ food: f }); break; }
    case "quick": quickAdd(b.dataset.id); break;
    case "quick-p": openQty({ direct: true }); break;
    case "entry": { const en = S.entries.find(x => x.id === b.dataset.id); if (en) openQty({ entry: en }); break; }
    case "qty-chip": $("qs-qty").value = fr1(+b.dataset.v); drawQty(); break;
    case "qty-save": saveQty(); break;
    case "qty-del": {
      const en = S.entries.find(x => x.id === QS.entryId); if (!en) return closeSheet();
      S.entries = S.entries.filter(x => x !== en); save("entries"); closeSheet(); renderAll();
      toast("Retiré de la journée", { label: "Annuler", fn: () => { S.entries.push(en); save("entries"); renderAll(); } });
      break;
    }
    case "food-new": {
      const fromPicker = !!$("pk-q");
      openFood(null, fromPicker && PK_Q.trim() ? { name: PK_Q.trim() } : {}, fromPicker ? "add" : ""); break;
    }
    case "food-code": openFood(null, { barcode: b.dataset.code }, "add"); break;
    case "food-edit": { const f = foodById(b.dataset.id); if (f) openFood(f); break; }
    case "ff-mode": readFood(); FF.mode = b.dataset.m; drawFood(); break;
    case "ff-save": saveFood(); break;
    case "ff-del": deleteFood(); break;
    case "scan": openScan(); break;
    case "scan-go": manualCode(); break;
    case "scan-retry": scanState(""); startCam(); break;
    case "range": H_RANGE = +b.dataset.n; renderHist(); break;
    case "ratio": {
      const r = Math.round((S.settings.ratio + .1 * +b.dataset.k) * 10) / 10;
      S.settings.ratio = Math.min(3, Math.max(.8, r)); updateGoal(); save("settings"); renderAll(); break;
    }
    case "export": exportData(); break;
    case "wipe": wipe(); break;
  }
});

/* ---------- Onglets et barre du haut ---------- */
const VIEWS = ["jour", "aliments", "hist", "reglages"];
function showTab(t) {
  TAB = t;
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-current", b.dataset.tab === t ? "page" : "false"));
  VIEWS.forEach(k => $("v-" + k).hidden = k !== t);
  $("nav-title").textContent = TITLES[t]();
  window.scrollTo(0, 0); onScroll();
}
function onScroll() { $("navbar").classList.toggle("scrolled", window.scrollY > 40); }
window.addEventListener("scroll", onScroll, { passive: true });
function renderAll() { renderJour(); renderAliments(); renderHist(); renderReglages(); $("nav-title").textContent = TITLES[TAB](); }

/* Glisser une fenêtre vers le bas pour la fermer (comme sur iOS). */
const SD = { armed: false, on: false, y0: 0, d: 0, samples: [] };
document.addEventListener("touchstart", e => {
  SD.armed = SD.on = false;
  if ($("modal").hidden || !$("dialog").hidden) return;
  const box = $("modal-box");
  if (!e.target.closest(".sheet") || e.target.closest("input")) return;
  SD.armed = box.scrollTop <= 0 || !!e.target.closest(".sheet-head");
  SD.y0 = e.touches[0].clientY; SD.d = 0; SD.samples = [[performance.now(), SD.y0]];
}, { passive: true });
document.addEventListener("touchmove", e => {
  if (!SD.armed) return;
  const box = $("modal-box"), y = e.touches[0].clientY;
  if (!SD.on) {
    const dy = y - SD.y0;
    if (dy < -4) { SD.armed = false; return; }
    if (dy > 4 && box.scrollTop <= 0) { SD.on = true; SD.y0 = y; box.style.transition = "none"; $("modal").style.transition = "none"; }
    else return;
  }
  SD.d = Math.max(0, y - SD.y0);
  SD.samples.push([performance.now(), y]); if (SD.samples.length > 6) SD.samples.shift();
  box.style.transform = `translateY(${SD.d}px)`;
  $("modal").style.backgroundColor = `rgba(0,0,0,${(.35 * Math.max(0, 1 - SD.d / box.offsetHeight)).toFixed(3)})`;
}, { passive: true });
function endSheetDrag() {
  if (!SD.on) { SD.armed = false; return; }
  SD.on = SD.armed = false;
  const box = $("modal-box"), w = $("modal");
  const [a, b] = [SD.samples[0], SD.samples[SD.samples.length - 1]];
  const v = b && a && b[0] > a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : 0;
  const close = SD.d > Math.min(160, box.offsetHeight * .3) || (v > .5 && SD.d > 30);
  box.style.transition = `transform ${close ? .22 : .3}s cubic-bezier(.2,.9,.3,1)`; w.style.transition = "background-color .22s";
  if (close) {
    box.style.transform = "translateY(100%)"; w.style.backgroundColor = "rgba(0,0,0,0)";
    setTimeout(() => { if (!$("modal").hidden) closeSheet(); }, 220);
  } else {
    box.style.transform = "translateY(0)"; w.style.backgroundColor = "";
    setTimeout(() => { if (!SD.on) { box.style.transition = ""; w.style.transition = ""; } }, 320);
  }
}
document.addEventListener("touchend", endSheetDrag, { passive: true });
document.addEventListener("touchcancel", endSheetDrag, { passive: true });

/* Fenêtres ouvertes : la page de derrière ne doit pas défiler */
let touchY = 0;
document.addEventListener("touchstart", e => { touchY = e.touches[0].clientY; }, { passive: true });
document.addEventListener("touchmove", e => {
  const sheetOpen = !$("modal").hidden, dialogOpen = !$("dialog").hidden;
  if (!sheetOpen && !dialogOpen) return;
  if (!e.cancelable) return;
  const sc = e.target.closest(".sheet");
  if (dialogOpen || !sc) { e.preventDefault(); return; }
  const dy = e.touches[0].clientY - touchY;
  const atTop = sc.scrollTop <= 0, atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1;
  if (sc.scrollHeight <= sc.clientHeight + 1 || (dy > 0 && atTop) || (dy < 0 && atBottom)) e.preventDefault();
}, { passive: false });
function syncLock() { document.documentElement.classList.toggle("locked", !$("modal").hidden || !$("dialog").hidden); }

/* Retour sur l'appli : nouveau jour, caméra coupée en arrière-plan */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { if (SCAN.stream) stopCam(); return; }
  const t = today();
  if (t !== SEEN_TODAY) { if (DAY === SEEN_TODAY) DAY = t; SEEN_TODAY = t; renderAll(); }
  if ($("cam-v") && !SCAN.stream && !$("cam").hidden) startCam();
});

/* ---------- Démarrage ---------- */
(async () => {
  try {
    for (const k of ["foods", "entries"]) { const v = await DB.get(k); if (v) S[k] = v; }
    const st = await DB.get("settings"); if (st) S.settings = { ...S.settings, ...st };
    navigator.storage?.persist?.();
  } catch (e) { toast("Stockage indisponible : les données ne seront pas gardées."); }
  renderAll(); showTab("jour");
})();

/* Mises à jour : dès qu'une nouvelle version est installée, l'appli se recharge toute seule. */
function reloadWhenIdle() {
  if (!$("modal").hidden || !$("dialog").hidden) { pendingReload = true; return; }
  location.reload();
}
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) reloadWhenIdle(); });
  navigator.serviceWorker.register("sw.js").then(reg => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
}
