import "@fontsource/archivo/latin-700.css";
import "@fontsource/archivo/latin-800.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { createStore } from "./data.js";
import { codeOf, drawQR, labelCanvas, qrText } from "./label.js";
import { startScanner, scanImageFile, extractId } from "./scanner.js";

registerSW({ immediate: true });

const STATUS = [
  ["recibido", "Recibido", "en origen"],
  ["transito", "En camino", "rumbo a destino"],
  ["destino", "En destino", "listo p/ entregar"],
  ["entregado", "Entregado", "cerrado"]
];
const STATUS_LABEL = Object.fromEntries(STATUS.map((s) => [s[0], s[1]]));

const S = {
  authReady: false, user: null, pkgs: new Map(), pending: new Set(), fromCache: true, loaded: false,
  online: navigator.onLine, filter: "todos", query: "", confirmDel: null, error: "", installEvt: null
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => { const v = Number(n); return isFinite(v) && v > 0 ? "$" + v.toFixed(2) + " USD" : ""; };
const fmtDate = (t) => { try { return new Date(t).toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
const who = (email) => (email || "").split("@")[0];
const store_ = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* */ } } };

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2800); }
function newId() {
  const a = "23456789abcdefghjkmnpqrstuvwxyz"; let id;
  const r = crypto.getRandomValues(new Uint8Array(7));
  do { id = "pk-" + Array.from(r, (b) => a[b % a.length]).join(""); crypto.getRandomValues(r); } while (S.pkgs.has(id));
  return id;
}
function route() {
  const h = decodeURIComponent(location.hash.slice(1)).toLowerCase();
  if (h === "nuevo") return { v: "form" };
  if (h.startsWith("editar-pk-")) return { v: "form", id: h.slice(7) };
  if (h.startsWith("pk-")) return { v: "detail", id: h };
  return { v: "list" };
}
function go(hash) { if (hash) location.hash = hash; else { history.pushState(null, "", location.pathname + location.search); render(); } }

/* ---------------- datos ---------------- */
const errText = (e) => {
  const c = e?.code || "";
  if (c.includes("permission-denied")) return "No tienes permiso para hacer ese cambio. Pide al administrador que revise tu cuenta.";
  if (c.includes("resource-exhausted")) return "Se alcanzó el límite gratuito de la base de datos por hoy.";
  if (c.includes("failed-precondition")) return "Abre la app en una sola pestaña para que la caché sin internet funcione.";
  return "Ocurrió un error con los datos (" + (c || e?.message || "desconocido") + ").";
};
const store = createStore({
  onAuth(u) { S.user = u; S.authReady = true; if (!u) { S.pkgs = new Map(); S.loaded = false; } render(); },
  onPackages(map, meta) { S.pkgs = map; S.pending = meta.pending; S.fromCache = meta.fromCache; S.loaded = true; render(); },
  onError(e) { console.error(e); toast(errText(e)); }
});
window.addEventListener("online", () => { S.online = true; renderSync(); });
window.addEventListener("offline", () => { S.online = false; renderSync(); });

function act(fn, okMsg) {
  try { fn(); if (okMsg) toast(S.online || store.mode === "local" ? okMsg : okMsg + " · se subirá al tener internet"); }
  catch (e) { toast(errText(e)); }
}

/* ---------------- encabezado ---------------- */
function renderSync() {
  const el = $("#sync");
  if (!S.user) { el.hidden = true; return; }
  el.hidden = false;
  const n = S.pending.size;
  let cls, txt;
  if (store.mode === "local") { cls = "test"; txt = "Modo prueba"; }
  else if (!S.online) { cls = "off"; txt = n ? `Sin internet · ${n} por subir` : "Sin internet"; }
  else if (n) { cls = "up"; txt = `Subiendo ${n}…`; }
  else if (S.fromCache) { cls = "up"; txt = "Conectando…"; }
  else { cls = "ok"; txt = "Al día"; }
  el.className = "sync " + cls; el.textContent = txt;
}
function renderMenu(open) {
  const m = $("#menu"), b = $("#menuBtn");
  b.setAttribute("aria-expanded", String(open)); m.hidden = !open;
  if (!open) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
  m.innerHTML = `
    <span class="who">${store.mode === "local" ? "Modo de prueba: los datos solo están en este teléfono" : "Sesión: " + esc(S.user?.email)}</span>
    ${S.installEvt ? `<button type="button" data-install>Instalar la app en este teléfono</button>` : ""}
    ${ios ? `<span class="who">Para instalar en iPhone: botón Compartir → “Agregar a inicio”.</span>` : ""}
    <button type="button" data-refresh>Recargar</button>
    ${store.mode === "local" ? "" : `<button type="button" data-logout>Cerrar sesión</button>`}`;
}

/* ---------------- vistas ---------------- */
function render() {
  renderSync();
  const logged = !!S.user;
  $("#menuBtn").hidden = !logged;
  $("#dock").hidden = !logged;
  const app = $("#app");
  if (!S.authReady) { app.innerHTML = `<div class="empty"><h3>Abriendo…</h3></div>`; return; }
  if (!logged) { app.innerHTML = loginView(); bindLogin(); return; }
  const r = route();
  let html = store.mode === "local" ? `<p class="note">Modo de prueba: todavía no está conectada la base de datos compartida, así que lo que registres solo se queda en este teléfono.</p>` : "";
  if (!S.loaded) html += `<div class="empty"><h3>Cargando paquetes…</h3><p>${S.online ? "" : "Sin internet. Si ya abriste la app antes en este teléfono, aparecerán en un momento."}</p></div>`;
  else if (r.v === "detail") html += detailView(r.id);
  else if (r.v === "form") html += formView(r.id);
  else html += listView();
  app.innerHTML = html;
  if (S.loaded && r.v === "detail" && S.pkgs.has(r.id)) drawQR($("#qrMini"), qrText(r.id), 2);
  if (S.loaded && r.v === "form") bindForm(r.id);
  if (S.loaded && r.v === "list") { const q = $("#q"); q.addEventListener("input", () => { S.query = q.value; renderRows(); }); }
}

function loginView() {
  return `
  <section class="card login">
    <h1>Entrar</h1>
    <p>Usa la cuenta que te dio el encargado de Paquetería Express. Solo necesitas internet la primera vez; después la app abre aunque no haya señal.</p>
    <form id="login" novalidate>
      <label>Correo<input id="l-email" type="email" autocomplete="username" required value="${esc(store_.get("pqx-email") || "")}"></label>
      <label>Contraseña<input id="l-pass" type="password" autocomplete="current-password" required></label>
      <p id="l-err" class="note err" hidden></p>
      <button class="primary" type="submit" id="l-btn">Entrar</button>
      <button type="button" id="l-reset">Olvidé mi contraseña</button>
    </form>
  </section>`;
}
function bindLogin() {
  const f = $("#login"), err = $("#l-err");
  const show = (m) => { err.textContent = m; err.hidden = false; };
  const authMsg = (e) => {
    const c = e?.code || "";
    if (c.includes("network")) return "No hay internet. Para entrar la primera vez necesitas conexión.";
    if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found") || c.includes("invalid-email")) return "El correo o la contraseña no coinciden.";
    if (c.includes("too-many-requests")) return "Demasiados intentos. Espera unos minutos.";
    if (c.includes("user-disabled")) return "Esta cuenta está desactivada.";
    return "No se pudo entrar (" + (c || "error") + ").";
  };
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); err.hidden = true;
    const email = $("#l-email").value.trim(), pass = $("#l-pass").value;
    if (!email || !pass) return show("Escribe tu correo y tu contraseña.");
    const b = $("#l-btn"); b.disabled = true; b.textContent = "Entrando…";
    try { await store.signIn(email, pass); store_.set("pqx-email", email); }
    catch (e2) { show(authMsg(e2)); b.disabled = false; b.textContent = "Entrar"; }
  });
  $("#l-reset").addEventListener("click", async () => {
    const email = $("#l-email").value.trim();
    if (!email) return show("Escribe tu correo arriba y vuelve a tocar “Olvidé mi contraseña”.");
    try { await store.resetPassword(email); toast("Te enviamos un correo para cambiar la contraseña."); }
    catch (e2) { show(authMsg(e2)); }
  });
}

function matches(id, p) {
  const f = S.filter;
  if (f === "nopagado" && p.pagado) return false;
  if (f === "transito" && !(p.estado === "recibido" || p.estado === "transito")) return false;
  if (f === "destino" && p.estado !== "destino") return false;
  if (f === "entregado" && p.estado !== "entregado") return false;
  if (f === "subir" && !S.pending.has(id)) return false;
  const q = S.query.trim().toLowerCase();
  if (!q) return true;
  const hay = [id, p.destinatario, p.destTel, p.remitente, p.remTel, p.destCiudad, p.destEstado, p.origen, p.contenido].join(" ").toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}
function rowsHTML() {
  if (!S.pkgs.size) return `<div class="empty"><h3>Todavía no hay paquetes</h3><p>Registra el primero: llenas los datos una vez, imprimes la etiqueta con QR y la pegas en la caja.</p><a class="btn primary" href="#nuevo">+ Registrar paquete</a></div>`;
  const list = [...S.pkgs.entries()].filter(([id, p]) => matches(id, p))
    .sort((a, b) => String(b[1].creado || "").localeCompare(String(a[1].creado || "")));
  if (!list.length) return `<div class="empty"><h3>Sin resultados</h3><p>Ningún paquete coincide con la búsqueda o el filtro.</p></div>`;
  return `<div class="list">` + list.slice(0, 300).map(([id, p]) => `
    <a class="row" href="#${id}">
      <span class="who">${esc(p.destinatario || "Sin nombre")}</span>
      <span class="tags">${p.pagado ? `<span class="pill paid">Pagado</span>` : `<span class="pill unpaid">No pagado</span>`}</span>
      <span class="route">${esc(p.origen || "?")} → ${esc([p.destCiudad, p.destEstado].filter(Boolean).join(", ") || "?")}</span>
      <span class="tags">${S.pending.has(id) ? `<span class="pill up">Por subir</span>` : ""}<span class="pill ${p.estado === "entregado" ? "done" : "st"}">${esc(STATUS_LABEL[p.estado] || "Recibido")}</span></span>
      <span class="code">${codeOf(id)} · ${esc(p.piezas || 1)} caja${(p.piezas || 1) > 1 ? "s" : ""}</span>
    </a>`).join("") + `</div>`;
}
function renderRows() { const r = $("#rows"); if (r) r.innerHTML = rowsHTML(); }
function listView() {
  const all = [...S.pkgs.values()];
  const owe = all.filter((p) => !p.pagado);
  const oweSum = owe.reduce((s, p) => s + (Number(p.costo) || 0), 0);
  const open = all.filter((p) => p.estado !== "entregado").length;
  const f = (k, l) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${S.filter === k}">${l}</button>`;
  return `
  <div class="stats">
    <button type="button" class="stat" data-filter="todos"><b>${all.length}</b><span>paquetes</span></button>
    <button type="button" class="stat" data-filter="transito"><b>${open}</b><span>sin entregar</span></button>
    <button type="button" class="stat owe" data-filter="nopagado"><b>${oweSum > 0 ? "$" + Math.round(oweSum).toLocaleString("es-MX") : owe.length}</b><span>${oweSum > 0 ? "por cobrar (" + owe.length + ")" : "no pagados"}</span></button>
  </div>
  <input id="q" type="search" placeholder="Buscar nombre, ciudad, teléfono o guía" value="${esc(S.query)}" aria-label="Buscar" enterkeyhint="search">
  <div class="chips">${f("todos", "Todos")}${f("nopagado", "No pagados")}${f("transito", "En camino")}${f("destino", "En destino")}${f("entregado", "Entregados")}${S.pending.size ? f("subir", "Por subir (" + S.pending.size + ")") : ""}</div>
  <div id="rows">${rowsHTML()}</div>`;
}

function phone(t) { return t ? `<a href="tel:${esc(t.replace(/[^\d+]/g, ""))}" class="mono">${esc(t)}</a>` : "—"; }
function detailView(id) {
  const p = S.pkgs.get(id);
  if (!p) return `<button class="back" type="button" data-go="">← Paquetes</button><div class="empty"><h3>No encontramos la guía ${esc(codeOf(id))}</h3><p>${S.online ? "Puede que la hayan borrado o que el código esté mal." : "Sin internet: si la registraron en otro teléfono, aparecerá cuando vuelva la conexión."}</p></div>`;
  const destino = [p.destCiudad, p.destEstado].filter(Boolean).join(", ");
  const hist = (p.historial || []).slice().sort((a, b) => String(b.t).localeCompare(String(a.t)));
  const costo = money(p.costo);
  return `
  <button class="back" type="button" data-go="">← Paquetes</button>
  ${S.pending.has(id) ? `<p class="note">Guardado en este teléfono. Se subirá en cuanto haya internet.</p>` : ""}
  <section class="card">
    <div class="head-line">
      <span class="eyebrow">Guía <span class="mono" style="color:var(--ink);font-size:15px">${codeOf(id)}</span></span>
      <span class="pill ${p.estado === "entregado" ? "done" : "st"}">${esc(STATUS_LABEL[p.estado] || "Recibido")}</span>
    </div>
    <div class="routebig">
      <div class="place"><small>Sale de</small><b>${esc(p.origen || "—")}</b></div>
      <svg width="34" height="20" viewBox="0 0 34 20" aria-hidden="true"><path d="M2 10h28M22 3l8 7-8 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div class="place"><small>Va a</small><b>${esc(destino || "—")}</b></div>
    </div>
    <div class="paybox ${p.pagado ? "paid" : "unpaid"}">
      <strong>${p.pagado ? "PAGADO" : "NO PAGADO"}</strong>
      <span class="amt">${p.pagado ? costo : costo ? "Cobrar " + costo : "Monto sin registrar"}</span>
    </div>
    <dl class="kv">
      <div><dt>Para</dt><dd>${esc(p.destinatario || "—")}</dd></div>
      <div><dt>Teléfono</dt><dd>${phone(p.destTel)}</dd></div>
      ${p.destDir ? `<div class="full"><dt>Dirección de entrega</dt><dd>${esc(p.destDir)}</dd></div>` : ""}
      <div><dt>Envía</dt><dd>${esc(p.remitente || "—")}</dd></div>
      <div><dt>Tel. remitente</dt><dd>${phone(p.remTel)}</dd></div>
      <div class="full"><dt>Contenido</dt><dd>${esc(p.contenido || "—")}</dd></div>
      <div><dt>Cajas</dt><dd>${esc(p.piezas || 1)}</dd></div>
      <div><dt>Peso</dt><dd>${p.peso ? esc(p.peso) + " lb" : "—"}</dd></div>
      ${p.valor ? `<div><dt>Valor declarado</dt><dd>${money(p.valor)}</dd></div>` : ""}
      ${p.notas ? `<div class="full"><dt>Notas</dt><dd>${esc(p.notas)}</dd></div>` : ""}
    </dl>
  </section>
  <section class="card">
    <span class="eyebrow">Actualizar</span>
    <div class="steps">${STATUS.map(([k, l, s]) => `<button type="button" data-status="${k}" aria-pressed="${p.estado === k}">${l}<small>${s}</small></button>`).join("")}</div>
    <div class="actions">
      <button type="button" data-pay="${p.pagado ? 0 : 1}" class="${p.pagado ? "" : "primary"}">${p.pagado ? "Marcar como no pagado" : "Marcar como pagado"}</button>
      <a class="btn" href="#editar-${id}">Editar datos</a>
    </div>
  </section>
  <section class="card qrside">
    <canvas id="qrMini" width="264" height="264" aria-label="Código QR de la guía"></canvas>
    <p>QR de la etiqueta. Escanéalo con el botón “Escanear” de la app (funciona sin internet) o con la cámara del teléfono.</p>
    <div class="actions" style="flex:1 1 100%">
      <button type="button" class="primary" data-label="${id}">Etiquetas (${esc(p.piezas || 1)})</button>
    </div>
  </section>
  <section class="card">
    <span class="eyebrow">Historial</span>
    <ul class="hist">${hist.map((h) => `<li><time>${fmtDate(h.t)}</time><span>${esc(h.msg)}${h.por ? `<small>${esc(who(h.por))}</small>` : ""}</span></li>`).join("") || "<li><span>Sin movimientos.</span></li>"}</ul>
  </section>
  ${S.confirmDel === id
    ? `<div class="confirm">¿Borrar la guía ${codeOf(id)} para todos? <button type="button" class="danger" data-del-yes="${id}">Sí, borrar</button><button type="button" data-del-no>Cancelar</button></div>`
    : `<button type="button" class="danger" data-del="${id}" style="align-self:flex-start">Borrar paquete</button>`}`;
}

const FIELDS = ["origen", "destCiudad", "destEstado", "destinatario", "destTel", "destDir", "remitente", "remTel", "contenido", "piezas", "peso", "valor", "costo", "notas"];
function formView(id) {
  const editing = id ? S.pkgs.get(id) : null;
  if (id && !editing) return `<button class="back" type="button" data-go="">← Paquetes</button><div class="empty"><h3>Paquete no encontrado</h3></div>`;
  const p = editing || { origen: store_.get("pqx-origen") || "Dallas, TX", destEstado: store_.get("pqx-estado") || "Guerrero", piezas: 1, pagado: false };
  const v = (k) => esc(p[k] ?? "");
  return `
  <button class="back" type="button" data-go="${editing ? id : ""}">← ${editing ? "Volver al paquete" : "Paquetes"}</button>
  <h1 style="font-size:26px">${editing ? "Editar " + codeOf(id) : "Nuevo paquete"}</h1>
  <form id="pform" novalidate>
    <fieldset><legend>Ruta</legend>
      <label class="full">Sale de<input id="f-origen" name="origen" value="${v("origen")}" placeholder="Dallas, TX" autocomplete="off"></label>
      <label>Ciudad o pueblo destino<input id="f-destCiudad" name="destCiudad" value="${v("destCiudad")}" placeholder="Iguala" autocomplete="off"></label>
      <label>Estado destino<input id="f-destEstado" name="destEstado" value="${v("destEstado")}" placeholder="Guerrero" autocomplete="off"></label>
    </fieldset>
    <fieldset><legend>Para quién</legend>
      <label>Nombre<input id="f-destinatario" name="destinatario" value="${v("destinatario")}" autocomplete="off" autocapitalize="words"></label>
      <label>Teléfono<input id="f-destTel" name="destTel" value="${v("destTel")}" inputmode="tel" autocomplete="off"></label>
      <label class="full">Dirección de entrega<textarea id="f-destDir" name="destDir">${v("destDir")}</textarea></label>
    </fieldset>
    <fieldset><legend>Quién envía</legend>
      <label>Nombre<input id="f-remitente" name="remitente" value="${v("remitente")}" autocomplete="off" autocapitalize="words"></label>
      <label>Teléfono<input id="f-remTel" name="remTel" value="${v("remTel")}" inputmode="tel" autocomplete="off"></label>
    </fieldset>
    <fieldset><legend>Paquete</legend>
      <label class="full">Contenido<input id="f-contenido" name="contenido" value="${v("contenido")}" placeholder="Ropa, zapatos, juguetes" autocomplete="off"></label>
      <label>Cajas<input id="f-piezas" name="piezas" type="number" min="1" max="50" value="${v("piezas")}" inputmode="numeric"></label>
      <label>Peso total (lb)<input id="f-peso" name="peso" type="number" min="0" step="0.1" value="${v("peso")}" inputmode="decimal"></label>
      <label class="full">Valor declarado (USD)<input id="f-valor" name="valor" type="number" min="0" step="0.01" value="${v("valor")}" inputmode="decimal"></label>
    </fieldset>
    <fieldset><legend>Cobro</legend>
      <label class="full">Costo del envío (USD)<input id="f-costo" name="costo" type="number" min="0" step="0.01" value="${v("costo")}" inputmode="decimal"></label>
      <div class="seg" role="radiogroup" aria-label="Pago">
        <label><input type="radio" id="f-pag-no" name="pagado" value="0" ${p.pagado ? "" : "checked"}> No pagado</label>
        <label><input type="radio" id="f-pag-si" name="pagado" value="1" ${p.pagado ? "checked" : ""}> Pagado</label>
      </div>
      <label class="full">Notas<textarea id="f-notas" name="notas" placeholder="Frágil, entregar solo a la persona, etc.">${v("notas")}</textarea></label>
    </fieldset>
    <p id="ferr" class="note err" hidden></p>
    <button class="primary" type="submit">${editing ? "Guardar cambios" : "Registrar y crear etiquetas"}</button>
  </form>`;
}
function bindForm(id) {
  const f = $("#pform"); if (!f) return;
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(f), g = (k) => String(fd.get(k) || "").trim();
    const err = $("#ferr");
    if (!g("destinatario") || !g("destCiudad") || !g("origen")) { err.textContent = "Faltan datos: nombre de quien recibe, origen y ciudad destino."; err.hidden = false; err.scrollIntoView({ block: "center" }); return; }
    const num = (k) => { const n = parseFloat(g(k)); return isFinite(n) ? n : null; };
    const old = id ? S.pkgs.get(id) : null;
    const nid = id || newId(), now = new Date().toISOString();
    const pagado = g("pagado") === "1";
    const data = {};
    FIELDS.forEach((k) => (data[k] = g(k)));
    Object.assign(data, { piezas: Math.min(50, Math.max(1, parseInt(g("piezas")) || 1)), peso: num("peso"), valor: num("valor"), costo: num("costo"), pagado, actualizado: now });
    store_.set("pqx-origen", data.origen); if (data.destEstado) store_.set("pqx-estado", data.destEstado);
    if (!old) {
      act(() => store.create(nid, { ...data, estado: "recibido", creado: now }, "Registrado en " + data.origen + (pagado ? " · pagado" : " · no pagado")), "Paquete registrado");
      location.hash = nid;
      setTimeout(() => showLabels(nid), 200);
    } else {
      const extra = old.pagado !== pagado ? (pagado ? " · marcado pagado" : " · marcado no pagado") : "";
      act(() => store.replace(nid, data, "Datos editados" + extra), "Cambios guardados");
      location.hash = nid;
    }
  });
}

/* ---------------- etiquetas ---------------- */
async function buildLabels(id) {
  const p = S.pkgs.get(id); const n = Math.max(1, Number(p.piezas) || 1);
  const out = [];
  for (let i = 1; i <= n; i++) out.push(await labelCanvas(id, p, i, n));
  return out;
}
const toBlob = (c) => new Promise((r) => c.toBlob(r, "image/png"));
async function showLabels(id) {
  if (!S.pkgs.get(id)) return;
  const m = $("#modal"); m.hidden = false;
  m.innerHTML = `<div class="card"><h3>Preparando etiquetas…</h3></div>`;
  const canvases = await buildLabels(id);
  const urls = canvases.map((c) => c.toDataURL("image/png"));
  const n = canvases.length;
  m.innerHTML = `<div class="card" role="dialog" aria-label="Etiquetas ${codeOf(id)}">
    <div class="head-line"><h3>Etiquetas ${codeOf(id)}</h3><button type="button" class="icon-btn" data-close aria-label="Cerrar" style="color:var(--ink)">✕</button></div>
    <img class="label" src="${urls[0]}" alt="Etiqueta 1 de ${n} con código QR">
    <p style="margin:0;color:var(--muted);font-size:14px">${n > 1 ? `Son ${n} etiquetas, una por caja (“1 de ${n}”, “2 de ${n}”…). ` : ""}Tamaño 4×6 pulgadas para impresora de etiquetas; también sale bien en hoja carta.</p>
    <div class="actions">
      <button type="button" class="primary" id="lbPrint">Imprimir</button>
      <button type="button" id="lbShare">Compartir / guardar</button>
    </div>
  </div>`;
  $("#lbPrint").onclick = () => {
    const pa = $("#print");
    pa.innerHTML = urls.map((u) => `<img src="${u}" alt="">`).join("");
    setTimeout(() => window.print(), 100);
  };
  $("#lbShare").onclick = async () => {
    const files = await Promise.all(canvases.map(async (c, i) => new File([await toBlob(c)], `etiqueta-${codeOf(id)}${n > 1 ? "-" + (i + 1) : ""}.png`, { type: "image/png" })));
    if (navigator.canShare?.({ files })) {
      try { await navigator.share({ files, title: "Etiquetas " + codeOf(id) }); } catch { /* cancelado */ }
      return;
    }
    files.forEach((f) => { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); });
  };
}

/* ---------------- escáner ---------------- */
let stopScan = null;
function closeModal() { if (stopScan) { stopScan(); stopScan = null; } $("#modal").hidden = true; $("#modal").innerHTML = ""; }
async function openScanner() {
  const m = $("#modal"); m.hidden = false;
  m.innerHTML = `<div class="card" role="dialog" aria-label="Escanear QR">
    <div class="head-line"><h3>Escanear etiqueta</h3><button type="button" class="icon-btn" data-close aria-label="Cerrar" style="color:var(--ink)">✕</button></div>
    <div class="scanbox"><video id="scanVideo" playsinline muted></video></div>
    <p id="scanMsg" style="margin:0;color:var(--muted);font-size:14px">Apunta la cámara al código QR de la etiqueta.</p>
    <form class="manual" id="manual"><input id="manualCode" placeholder="O escribe la guía: PK-…" aria-label="Número de guía" autocomplete="off"><button type="submit">Ir</button></form>
    <button type="button" id="scanPhoto">Usar una foto</button>
  </div>`;
  $("#manual").addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = $("#manualCode").value.trim().toLowerCase();
    const id = extractId(raw) || extractId("pk-" + raw.replace(/^pk-?/, ""));
    if (id) { closeModal(); location.hash = id; } else toast("Escribe el código de la guía, por ejemplo PK-7F3K2QA.");
  });
  $("#scanPhoto").onclick = () => $("#scanFile").click();
  try {
    stopScan = await startScanner($("#scanVideo"), (id) => {
      stopScan = null; navigator.vibrate?.(60); closeModal(); location.hash = id;
      if (!S.pkgs.has(id)) toast("Esa guía no está en este teléfono todavía.");
    });
  } catch (e) {
    const msg = $("#scanMsg");
    if (msg) msg.textContent = e?.name === "NotAllowedError"
      ? "No hay permiso para usar la cámara. Actívalo en los ajustes del teléfono, o usa una foto."
      : "No se pudo abrir la cámara. Usa una foto o escribe la guía.";
  }
}
$("#scanFile").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  try {
    const id = await scanImageFile(file);
    if (!id) return toast("No se encontró un QR de guía en la foto. Acércate y que salga enfocado.");
    closeModal(); location.hash = id;
  } catch { toast("No se pudo leer la foto."); }
});

/* ---------------- eventos ---------------- */
document.addEventListener("click", (e) => {
  if (e.target.id === "modal") { closeModal(); return; }
  const t = e.target.closest("[data-go],[data-filter],[data-status],[data-pay],[data-label],[data-del],[data-del-yes],[data-del-no],[data-close],[data-install],[data-refresh],[data-logout]");
  if (!t) { if (!e.target.closest("#menu,#menuBtn")) renderMenu(false); return; }
  const d = t.dataset;
  if (d.go !== undefined) return go(d.go);
  if (d.filter) { S.filter = d.filter; if (route().v !== "list") go(""); else render(); return; }
  if (d.close !== undefined) return closeModal();
  if (d.install !== undefined) { S.installEvt?.prompt(); S.installEvt = null; renderMenu(false); return; }
  if (d.refresh !== undefined) return location.reload();
  if (d.logout !== undefined) { renderMenu(false); store.signOut(); return; }
  const id = route().id;
  if (d.status) {
    const p = S.pkgs.get(id); if (!p || p.estado === d.status) return;
    const msg = { recibido: "Recibido en " + (p.origen || "origen"), transito: "Salió rumbo a " + (p.destCiudad || "destino"), destino: "Llegó a " + (p.destCiudad || "destino"), entregado: "Entregado a " + (p.destinatario || "destinatario") }[d.status];
    return act(() => store.update(id, { estado: d.status }, msg), STATUS_LABEL[d.status]);
  }
  if (d.pay !== undefined) { const pag = d.pay === "1"; return act(() => store.update(id, { pagado: pag }, pag ? "Marcado como pagado" : "Marcado como no pagado"), pag ? "Pagado" : "No pagado"); }
  if (d.label) return showLabels(d.label);
  if (d.del) { S.confirmDel = d.del; return render(); }
  if (d.delNo !== undefined) { S.confirmDel = null; return render(); }
  if (d.delYes) { const x = d.delYes; S.confirmDel = null; act(() => store.remove(x), "Paquete borrado"); go(""); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); renderMenu(false); } });
$("#menuBtn").addEventListener("click", () => renderMenu($("#menu").hidden));
$("#scanBtn").addEventListener("click", openScanner);
$("#brand").addEventListener("click", (e) => { e.preventDefault(); S.filter = "todos"; go(""); });
window.addEventListener("hashchange", () => { S.confirmDel = null; closeModal(); renderMenu(false); render(); window.scrollTo(0, 0); });
window.addEventListener("afterprint", () => { $("#print").innerHTML = ""; });
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEvt = e; });
render();
