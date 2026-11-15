/**
 * Amiga Invisible — Google Apps Script backend (container-bound to the Sheet).
 *
 * SHEET LAYOUT (run setup() once to create it)
 *   "event"   key | value, one setting per row. Edit by hand:
 *               nombre       title shown at the top of the page
 *               presupuesto  free text, e.g. "20 €" or "$30"
 *               fecha        free text or a real date cell (both are handled)
 *               organizador  who to ask about a forgotten PIN
 *               nota         optional line under the title
 *   "people"  one row per participant. This tab IS the roster.
 *               name | pin | wishlist | exclusions | joinedAt
 *             - pin         4 digits, stored as TEXT so "0042" keeps its zeros.
 *                           Forgotten PIN: read it here, or type a new one.
 *             - exclusions  comma-separated names this person must not be paired
 *                           with. Applied in BOTH directions, so a couple only
 *                           needs it written on one of the two rows.
 *   "draw"    giver | receiver | seenAt | changedAt. Written by the script only.
 *             Hidden tab. Hidden is not secret: the Sheet's owner can unhide it.
 *             - seenAt     set when the giver first opens their gift on the page
 *             - changedAt  set when a latecomer was spliced in AFTER this giver
 *                          had already looked, so their name is now different
 *
 * SECRECY RULES — do not weaken these
 *   (a) No request ever returns more than ONE person's assignment. There is no
 *       "dump all" path. doGet() never returns a name from the draw tab.
 *   (b) The draw is NOT reachable over HTTP. runDraw() runs from this editor or
 *       from the Sheet's "Sorteo" menu. A draw endpoint would be a re-draw oracle.
 *   (c) A person sees their assignment only with their name + PIN. There is no
 *       lockout (family app, by choice), so a 4-digit PIN stops curiosity, not a
 *       determined relative with a script: it is at most 10,000 guesses.
 *
 * LATECOMERS
 *   Someone who joins after the draw is spliced into the chain: one existing
 *   pair A -> B becomes A -> NEW -> B. Only A's assignment changes. A giver who
 *   has not looked yet is preferred; if A had already looked, A's page shows a
 *   warning and the public banner asks everyone to check again until A does.
 *
 * DEPLOY
 *   Deploy ▸ New deployment ▸ Web app. Execute as: Me. Who has access: Anyone.
 *   Later updates: Manage deployments ▸ pencil ▸ Version: New version.
 *   ("New deployment" again would mint a NEW /exec URL and orphan the page.)
 *
 * API (same shape as server.py)
 *   GET                                   -> {event, people:[names], drawn, recheck}
 *   POST {action:"join", name, pin, wishlist}     -> me-payload
 *   POST {action:"me", name, pin}                 -> me-payload
 *   POST {action:"wishlist", name, pin, wishlist} -> me-payload
 *   POST {action:"seen", name, pin}               -> me-payload (I opened my gift)
 *   me-payload = {ok, event, people, drawn, recheck, me:{name, wishlist},
 *                 match: null | {name, wishlist, changed}}
 *   Errors come back as HTTP 200 {error:"<code>"}: bad_name, bad_pin_format,
 *   exists, no_slot, no_user, bad_pin.
 */

const T_EVENT = "event", T_PEOPLE = "people", T_DRAW = "draw";
const P_HEAD = ["name", "pin", "wishlist", "exclusions", "joinedAt"];
const D_HEAD = ["giver", "receiver", "seenAt", "changedAt"];
const MAX_TRIES = 20000;
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
               "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/* ======================= run from the editor / menu ======================= */

/** Run once. Safe to re-run: it never clobbers an existing tab. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const made = [];
  if (!ss.getSheetByName(T_EVENT)) {
    const sh = ss.insertSheet(T_EVENT, 0);
    sh.getRange("A:B").setNumberFormat("@");
    sh.getRange(1, 1, 6, 2).setValues([
      ["clave", "valor"],
      ["nombre", "Amiga Invisible"],
      ["presupuesto", ""],
      ["fecha", ""],
      ["organizador", "Alon"],
      ["nota", ""]]);
    sh.setFrozenRows(1);
    made.push(T_EVENT);
  }
  if (!ss.getSheetByName(T_PEOPLE)) {
    const sh = ss.insertSheet(T_PEOPLE, 1);
    // Plain text everywhere: otherwise Sheets turns PIN 0042 into the number 42,
    // and a wishlist starting with "=" into a formula.
    sh.getRange("A:E").setNumberFormat("@");
    sh.getRange(1, 1, 1, P_HEAD.length).setValues([P_HEAD]);
    sh.setFrozenRows(1);
    made.push(T_PEOPLE);
  }
  if (!ss.getSheetByName(T_DRAW)) {
    const sh = ss.insertSheet(T_DRAW, 2);
    sh.getRange("A:D").setNumberFormat("@");
    sh.getRange(1, 1, 1, D_HEAD.length).setValues([D_HEAD]);
    sh.hideSheet();
    made.push(T_DRAW);
  }
  return say_(made.length ? "creado: " + made.join(", ") : "ya estaba todo creado");
}

/** Adds a menu to the Sheet, so the draw doesn't need the script editor. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("Sorteo")
    .addItem("Hacer el sorteo", "runDraw")
    .addItem("Comprobar (sin sortear)", "checkDraw")
    .addItem("Meter a quien falte", "addLatecomers")
    .addSeparator()
    .addItem("Repetir el sorteo (¡cambia todo!)", "forceRedraw")
    .addToUi();
}

/** The draw. Refuses if one already exists: a silent re-draw after people have
 *  looked is the worst bug this app can have. */
function runDraw() { return draw_(false, false); }

/** Validates names, exclusions and feasibility without writing anything. */
function checkDraw() { return draw_(false, true); }

/** Throws away the existing draw and makes a new one. Everyone must look again. */
function forceRedraw() { return draw_(true, false); }

/**
 * For rows typed into "people" by hand after the draw (e.g. a latecomer who needs
 * exclusions set BEFORE being placed): splices in everyone not yet in the draw.
 */
function addLatecomers() {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const people = readPeople_();
    if (!readDraw_().length) return fail_("Todavía no hay sorteo. Usa runDraw().");
    const added = [];
    for (var i = 0; i < people.length; i++) {
      const draw = readDraw_();
      if (giverRow_(draw, people[i].name)) continue;
      if (!splice_(people[i], people, draw))
        return fail_("No hay hueco para \"" + people[i].name + "\" con sus exclusiones. " +
                     (added.length ? "Sí se metió a: " + added.join(", ") + ". " : "") +
                     "Quita alguna exclusión o repite el sorteo.");
      added.push(people[i].name);
    }
    return say_(added.length ? "Dentro: " + added.join(", ") + "."
                             : "No faltaba nadie: todo el mundo está en el sorteo.");
  } finally {
    lock.releaseLock();
  }
}

function draw_(force, dryRun) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const people = readPeople_();
    const had = readDraw_().length;
    if (had && !force && !dryRun)
      return fail_("Ya hay un sorteo hecho (" + had + " personas). No se ha cambiado nada. " +
                   "Para repetirlo a propósito: forceRedraw().");
    const res = computeDraw_(people);
    if (res.error) return fail_(res.error);
    if (dryRun) return say_("Todo bien: " + people.length + " personas, el sorteo es posible.");

    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(T_DRAW);
    const last = sh.getLastRow();
    if (last > 1) sh.getRange(2, 1, last - 1, 4).clearContent();
    sh.getRange(2, 1, res.pairs.length, 2).setValues(res.pairs);
    sh.hideSheet();
    return say_("Sorteo hecho: " + res.pairs.length + " personas. " +
                "Ya pueden entrar con su nombre y su clave.");
  } finally {
    lock.releaseLock();
  }
}

/**
 * banned[i][j] = true when i must not give to j. Symmetric on purpose.
 * strict: an exclusion naming nobody on the list is an error (typo guard for the
 * draw). Non-strict ignores it, so a latecomer's join can't be blocked by one.
 */
function banned_(people, strict) {
  const n = people.length, idx = {};
  for (var i = 0; i < n; i++) {
    const k = nkey_(people[i].name);
    if (idx[k] != null) {
      if (strict) return { error: "Nombre repetido en la pestaña people: \"" + people[i].name + "\"." };
      continue;
    }
    idx[k] = i;
  }
  const banned = people.map(function () { return {}; });
  for (var a = 0; a < n; a++) {
    banned[a][a] = true;
    const names = String(people[a].exclusions || "").split(/[,;\n]/);
    for (var x = 0; x < names.length; x++) {
      const k2 = nkey_(names[x]);
      if (!k2) continue;
      if (idx[k2] == null) {
        if (strict) return { error: "Exclusión de \"" + people[a].name + "\": no hay nadie llamado \"" +
                                    names[x].trim() + "\" en la lista. Corrige el nombre." };
        continue;
      }
      banned[a][idx[k2]] = true;
      banned[idx[k2]][a] = true;
    }
  }
  return { banned: banned, idx: idx };
}

/**
 * Pure logic, no Sheet access: people -> {pairs:[[giver, receiver], ...]} | {error}.
 * Shuffle-and-check is uniform over valid draws and instant at family size. The
 * pre-checks name the impossible constraint instead of looping forever.
 */
function computeDraw_(people) {
  const n = people.length;
  if (n < 3) return { error: "Hacen falta al menos 3 personas (hay " + n + ")." };
  const b = banned_(people, true);
  if (b.error) return b;
  const banned = b.banned;
  for (var p = 0; p < n; p++) {
    var free = 0;
    for (var q = 0; q < n; q++) if (!banned[p][q]) free++;
    if (!free)
      return { error: "Imposible: \"" + people[p].name + "\" tiene excluidas a todas las " +
                      "demás personas. Quita alguna exclusión." };
  }
  const order = people.map(function (_, i) { return i; });
  for (var t = 0; t < MAX_TRIES; t++) {
    for (var s = n - 1; s > 0; s--) {                       // Fisher-Yates
      const r = Math.floor(Math.random() * (s + 1));
      const tmp = order[s]; order[s] = order[r]; order[r] = tmp;
    }
    var ok = true;
    for (var g = 0; g < n && ok; g++) if (banned[g][order[g]]) ok = false;
    if (ok)
      return { pairs: people.map(function (pp, g2) { return [pp.name, people[order[g2]].name]; }) };
  }
  return { error: "Imposible con estas exclusiones: tras " + MAX_TRIES + " intentos no hay " +
                  "ningún sorteo válido. Seguramente hay un grupo que se excluye entre sí y " +
                  "no queda nadie fuera a quien regalar. Quita alguna exclusión." };
}

/**
 * Pure logic: which existing pair should a latecomer be spliced into?
 * draw = [{giver, receiver, seenAt}], returns an index into draw, or -1.
 * A -> B becomes A -> NEW -> B, so NEW must be allowed with both A and B.
 * Givers who have not opened their gift are preferred: nobody notices.
 */
function pickSlot_(newcomer, people, draw) {
  const b = banned_(people, false);
  const me = b.idx[nkey_(newcomer.name)];
  const fresh = [], seen = [];
  for (var i = 0; i < draw.length; i++) {
    const g = b.idx[nkey_(draw[i].giver)], r = b.idx[nkey_(draw[i].receiver)];
    if (g == null || r == null || g === me || r === me) continue;
    if (b.banned[g][me] || b.banned[me][r]) continue;
    (draw[i].seenAt ? seen : fresh).push(i);
  }
  const pool = fresh.length ? fresh : seen;
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : -1;
}

/** Writes the splice. Returns false when exclusions leave no valid pair. */
function splice_(newcomer, people, draw) {
  const i = pickSlot_(newcomer, people, draw);
  if (i < 0) return false;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(T_DRAW);
  const old = draw[i], now = new Date().toISOString();
  // A had already looked -> clear seenAt and stamp changedAt so A gets warned
  sh.getRange(old.row, 1, 1, 4).setValues([[
    safe_(old.giver), safe_(newcomer.name), "", old.seenAt ? now : old.changedAt]]);
  sh.getRange(Math.max(sh.getLastRow(), 1) + 1, 1, 1, 4).setValues([[
    safe_(newcomer.name), safe_(old.receiver), "", ""]]);
  return true;
}

/* ============================== web app ============================== */

/** Public and unauthenticated: the roster of NAMES and the event. Nothing else. */
function doGet(e) {
  return json_(state_(readPeople_(), readDraw_()));
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = JSON.parse(e.postData.contents);
    const action = String(p.action || "");
    const people = readPeople_();
    const draw = readDraw_();
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === "join") {
      const name = String(p.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
      const pin = String(p.pin || "").trim();
      if (nkey_(name).length < 2) return json_({ error: "bad_name" });
      if (!/^\d{4}$/.test(pin)) return json_({ error: "bad_pin_format" });
      if (find_(people, name)) return json_({ error: "exists" });
      const sh = ss.getSheetByName(T_PEOPLE);
      const me = { row: blankRow_(sh), name: name, pin: pin,
                   wishlist: wish_(p.wishlist), exclusions: "" };
      people.push(me);
      // after the draw: splice first, and only then create the row
      if (draw.length && !splice_(me, people, draw)) return json_({ error: "no_slot" });
      sh.getRange(me.row, 1, 1, 5).setValues([[
        safe_(name), pin, safe_(me.wishlist), "", new Date().toISOString()]]);
      return json_(mine_(me, people, readDraw_()));
    }

    if (action !== "me" && action !== "wishlist" && action !== "seen")
      return json_({ error: "bad_action" });
    const me = find_(people, p.name);
    if (!me) return json_({ error: "no_user" });
    if (!me.pin || String(p.pin || "").trim() !== me.pin) return json_({ error: "bad_pin" });

    if (action === "wishlist") {
      me.wishlist = wish_(p.wishlist);
      ss.getSheetByName(T_PEOPLE).getRange(me.row, 3).setValue(safe_(me.wishlist));
    }
    if (action === "seen") {
      const mineRow = giverRow_(draw, me.name);
      if (mineRow && !mineRow.seenAt) {
        mineRow.seenAt = new Date().toISOString();
        ss.getSheetByName(T_DRAW).getRange(mineRow.row, 3).setValue(mineRow.seenAt);
      }
    }
    return json_(mine_(me, people, draw));
  } catch (err) {
    return json_({ error: "server", detail: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** Everything ONE authenticated person may see: their own draw row, no other. */
function mine_(me, people, draw) {
  const out = state_(people, draw);
  out.ok = true;
  out.me = { name: me.name, wishlist: me.wishlist };
  out.match = null;
  const row = giverRow_(draw, me.name);
  if (row) {
    const r = find_(people, row.receiver);
    out.match = { name: r ? r.name : row.receiver, wishlist: r ? r.wishlist : "",
                  changed: !!(row.changedAt && !row.seenAt) };
  }
  return out;
}

/** Public state. From the draw it exposes two numbers and never a name. */
function state_(people, draw) {
  var recheck = 0;
  for (var i = 0; i < draw.length; i++) if (draw[i].changedAt && !draw[i].seenAt) recheck++;
  return { event: readEvent_(),
           people: people.map(function (p) { return p.name; }),
           drawn: draw.length > 0,
           recheck: recheck };
}

/* ============================== sheet I/O ============================== */

function readEvent_() {
  const out = { nombre: "Amiga Invisible", presupuesto: "", fecha: "", organizador: "", nota: "" };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(T_EVENT);
  if (!sh) return out;
  const rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    const k = String(rows[i][0] || "").trim().toLowerCase();
    if (k in out) out[k] = text_(rows[i][1]);
  }
  return out;
}

/** A date typed into a cell arrives as a Date, not text. Render it in Spanish. */
function text_(v) {
  if (v === "" || v == null) return "";
  if (Object.prototype.toString.call(v) === "[object Date]")
    return v.getDate() + " de " + MESES[v.getMonth()];
  return String(v).trim();
}

function readPeople_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(T_PEOPLE);
  if (!sh) return [];
  const rows = sh.getDataRange().getValues();
  const out = [];
  for (var i = 1; i < rows.length; i++) {
    const name = text_(rows[i][0]);
    if (!name) continue;
    out.push({ row: i + 1, name: name, pin: pin_(rows[i][1]),
               wishlist: rows[i][2] == null ? "" : String(rows[i][2]).trim(),
               exclusions: rows[i][3] == null ? "" : String(rows[i][3]) });
  }
  return out;
}

/** [{row, giver, receiver, seenAt, changedAt}] */
function readDraw_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(T_DRAW);
  if (!sh) return [];
  const rows = sh.getDataRange().getValues();
  const out = [];
  for (var i = 1; i < rows.length; i++) {
    if (!text_(rows[i][0]) || !text_(rows[i][1])) continue;
    out.push({ row: i + 1, giver: text_(rows[i][0]), receiver: text_(rows[i][1]),
               seenAt: stamp_(rows[i][2]), changedAt: stamp_(rows[i][3]) });
  }
  return out;
}

function giverRow_(draw, name) {
  const k = nkey_(name);
  for (var i = 0; i < draw.length; i++) if (nkey_(draw[i].giver) === k) return draw[i];
  return null;
}

/** A timestamp cell: text normally, a Date if the column lost its text format. */
function stamp_(v) {
  if (v === "" || v == null) return "";
  if (Object.prototype.toString.call(v) === "[object Date]") return v.toISOString();
  return String(v).trim();
}

/** A PIN typed by hand into a non-text cell loses its leading zeros: 0042 -> 42. */
function pin_(v) {
  const s = String(v == null ? "" : v).trim();
  if (!/^\d{1,4}$/.test(s)) return "";
  return ("0000" + s).slice(-4);
}

/** First row with an empty name cell, else one past the end. Never appendRow(). */
function blankRow_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return 2;
  const col = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) if (!String(col[i][0] == null ? "" : col[i][0]).trim()) return i + 2;
  return last + 1;
}

function find_(people, name) {
  const k = nkey_(name);
  for (var i = 0; i < people.length; i++) if (nkey_(people[i].name) === k) return people[i];
  return null;
}

/** Same normalisation as the page: accents, case and punctuation don't matter. */
function nkey_(x) {
  return String(x || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function wish_(v) { return String(v == null ? "" : v).trim().slice(0, 1000); }

/** User text that starts like a formula gets a leading space so Sheets stores it
 *  as text. Readers trim, so the space never reaches the page. */
function safe_(s) { return /^[=+\-@]/.test(s) ? " " + s : s; }

function say_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, "Sorteo", 10); } catch (err) {}
  return msg;
}

/** Fail loudly: red error in the editor, alert in the Sheet menu. */
function fail_(msg) {
  Logger.log("ERROR: " + msg);
  throw new Error(msg);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
