"use strict";

const TOKEN = new URLSearchParams(location.search).get("t") || "";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  snapshot: null,
  world: null,
  status: null,
  busy: false,
  filter: "all",
  selected: new Set(),
  plan: null, // last install preview result
  planDirty: false, // uploads changed since the preview
  uploading: new Map(), // top-level name -> {done, total}
  beta: null, // pending world edits
  mode: null,
  activeProfile: null,
};

// ---- helpers ----------------------------------------------------------------------------------

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

const ANSI_RE = /\x1b\[([0-9;]*)m/;
const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = isError ? "error" : "";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const icon = {
  close: '<svg aria-hidden="true" viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
  warn: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

// ---- console ------------------------------------------------------------------------------------

// The CLI's colour codes (console.py `C`), mapped to classes in app.css.
const ANSI_CLASSES = { 1: "ansi-bold", 2: "ansi-dim", 91: "ansi-red", 92: "ansi-green", 93: "ansi-yellow", 96: "ansi-cyan" };

/** Turn one line with ANSI colour codes into safe HTML spans. */
function ansiToHtml(line) {
  let html = "";
  let classes = new Set();
  String(line)
    .split(ANSI_RE)
    .forEach((part, index) => {
      if (index % 2 === 1) {
        for (const code of (part || "0").split(";").map(Number)) {
          if (code === 0) classes = new Set();
          else if (ANSI_CLASSES[code]) {
            if (code >= 90) [...classes].filter((c) => c !== "ansi-bold" && c !== "ansi-dim").forEach((c) => classes.delete(c));
            classes.add(ANSI_CLASSES[code]);
          }
        }
        return;
      }
      if (part) html += classes.size ? `<span class="${[...classes].join(" ")}">${esc(part)}</span>` : esc(part);
    });
  return html;
}

function appendLog(html) {
  const pre = $("#log");
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.insertAdjacentHTML("beforeend", html + "\n");
  if (stick) pre.scrollTop = pre.scrollHeight;
}

const log = (line) => appendLog(ansiToHtml(line));
const logMark = (text) => appendLog(`<span class="log-mark">— ${esc(text)} —</span>`);

function setConsole(status, title, sub = "") {
  $("#console-dot").className = `dot ${status}`;
  $("#console-title").textContent = title;
  $("#console-sub").textContent = sub;
}

// ---- api & jobs -----------------------------------------------------------------------------------

async function api(method, path, body, extraHeaders = {}) {
  const headers = { "X-BPM-Token": TOKEN, ...extraHeaders };
  let payload = body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(path, { method, headers, body: payload });
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }
  if (!response.ok) {
    const error = new Error((data && data.error) || `${response.status} ${response.statusText}`);
    error.code = data && data.error_code;
    throw error;
  }
  return data;
}

function setBusy(busy) {
  state.busy = busy;
  $$("button, .proto input").forEach((el) => {
    if (["clear-log", "copy-log", "toggle-console"].includes(el.id) || el.closest("dialog") || el.closest(".tabs")) return;
    if (busy) {
      el.dataset.wasDisabled = el.disabled ? "1" : "";
      el.disabled = true;
    } else if (el.dataset.wasDisabled !== undefined) {
      el.disabled = el.dataset.wasDisabled === "1";
      delete el.dataset.wasDisabled;
    }
  });
  if (!busy) {
    updateSelection();
    updateInstallButtons();
  }
}

/** Start a server job, stream its console lines into the dock, and resolve with the finished job. */
async function runJob(path, body, { quiet = false, title = "Working" } = {}) {
  if (state.busy) throw new Error("Another task is running");
  setBusy(true);
  setConsole("busy", title);
  try {
    const { job: id } = await api("POST", path, body);
    let since = 0;
    for (;;) {
      const job = await api("GET", `/api/jobs/${id}?since=${since}`);
      if (!quiet || job.status === "error") job.lines.forEach(log);
      const last = job.lines.filter((line) => stripAnsi(line).trim()).pop();
      if (last) $("#console-sub").textContent = stripAnsi(last).trim();
      since = job.next;
      if (job.status !== "running") {
        if (job.status === "error") {
          setConsole("error", `${title} failed`, job.error || "");
          const error = new Error(job.error || "Task failed");
          error.code = job.error_code;
          error.data = job.error_data;
          throw error;
        }
        const warnings = job.warnings.length;
        setConsole("ok", `${title} — done`, warnings ? `${warnings} warning(s)` : `${job.elapsed}s`);
        return job;
      }
      await sleep(job.lines.length ? 120 : 300);
    }
  } finally {
    setBusy(false);
  }
}

/** Open a <dialog> whose form uses method="dialog"; resolves true when the "ok" button submits it. */
function showDialog(dialog) {
  const form = $("form", dialog);
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    const finish = (value) => {
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("cancel", onCancel);
      resolve(value);
    };
    const onSubmit = (event) => finish(!!event.submitter && event.submitter.value === "ok");
    const onCancel = () => finish(false);
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("cancel", onCancel);
  });
}

function confirmDialog(title, html, okLabel = "Continue", danger = false) {
  $("#confirm-title").textContent = title;
  $("#confirm-body").innerHTML = html;
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.className = danger ? "btn danger" : "btn primary";
  return showDialog($("#confirm-dialog"));
}

// ---- connect screen ---------------------------------------------------------------------------------

const DEFAULT_PORTS = { ftp: "21", ftps: "21", sftp: "22" };
const PROTO_LABELS = { sftp: "SFTP", ftp: "FTP", ftps: "FTPS", local: "LOCAL" };

const protocol = () => $("#connect-form").elements.protocol.value;

function syncProtocolFields() {
  const proto = protocol();
  $$(".remote-only").forEach((el) => (el.hidden = proto === "local"));
  $$(".sftp-only").forEach((el) => (el.hidden = proto !== "sftp"));
  $$(".ftps-only").forEach((el) => (el.hidden = proto !== "ftps"));
  $$(".ftp-only").forEach((el) => (el.hidden = proto !== "ftp" && proto !== "ftps"));
  const form = $("#connect-form");
  form.elements.host.required = proto !== "local";
  form.elements.port.placeholder = DEFAULT_PORTS[proto] || "";
  $("#root-label").textContent = proto === "local" ? "Server folder on this computer" : "Folder on the server";
  form.elements.root.placeholder = proto === "local" ? "Empty = the bundled run/ folder, or e.g. C:\\servers\\bedrock" : "Empty = login folder, e.g. /home/container";
}

function formSettings() {
  const f = $("#connect-form").elements;
  return {
    protocol: protocol(),
    host: f.host.value.trim(),
    port: f.port.value.trim(),
    username: f.username.value.trim(),
    password: f.password.value,
    key_file: f.key_file.value.trim(),
    key_passphrase: f.key_passphrase.value,
    root: f.root.value.trim(),
    tls_verify: !f.allow_self_signed.checked,
    passive: !f.active_mode.checked,
  };
}

function formLayout(form) {
  const f = form.elements;
  return {
    server_root: f.server_root.value.trim(),
    worlds_dir: f.worlds_dir.value.trim(),
    bp_dir: f.bp_dir.value.trim(),
    rp_dir: f.rp_dir.value.trim(),
    pack_scope: f.pack_scope.value,
  };
}

function fillLayout(form, layout) {
  const f = form.elements;
  layout = layout || {};
  ["server_root", "worlds_dir", "bp_dir", "rp_dir"].forEach((key) => (f[key].value = layout[key] || ""));
  f.pack_scope.value = layout.pack_scope || "shared";
}

function fillSettings(settings) {
  const f = $("#connect-form").elements;
  settings = settings || {};
  const proto = settings.protocol || "sftp";
  $(`#connect-form input[name=protocol][value="${proto}"]`).checked = true;
  f.host.value = settings.host || "";
  f.port.value = settings.port || "";
  f.username.value = settings.username || "";
  f.root.value = settings.root || "";
  f.key_file.value = settings.key_file || "";
  f.key_passphrase.value = "";
  f.allow_self_signed.checked = settings.tls_verify === false;
  f.active_mode.checked = settings.passive === false;
  f.password.value = "";
  syncProtocolFields();
}

function profileAddress(settings) {
  if (!settings) return "";
  if (settings.protocol === "local") return settings.root || "run/";
  const user = settings.username ? `${settings.username}@` : "";
  const port = settings.port || DEFAULT_PORTS[settings.protocol] || "";
  return `${user}${settings.host}:${port} ${settings.root || "/"}`;
}

function renderProfiles(profiles) {
  const list = $("#profile-list");
  if (!profiles.length) {
    list.innerHTML = '<p class="empty-note">No saved servers yet. Connect once with “Save as a server” ticked.</p>';
    return;
  }
  list.innerHTML = profiles
    .map((p) => {
      const proto = (p.settings && p.settings.protocol) || "sftp";
      return `<div class="profile ${p.name === state.activeProfile ? "active" : ""}" data-profile="${esc(p.name)}" role="button" tabindex="0">
        <span class="proto-tag ${esc(proto)}">${esc(PROTO_LABELS[proto] || proto)}</span>
        <span class="names"><b>${esc(p.name)}</b><span class="addr">${esc(profileAddress(p.settings))}</span></span>
        <button type="button" class="del" data-delete="${esc(p.name)}" aria-label="Delete ${esc(p.name)}">${icon.close}</button>
      </div>`;
    })
    .join("");
}

function pickProfile(name) {
  const profile = (state.snapshot.profiles || []).find((p) => p.name === name);
  if (!profile) return;
  state.activeProfile = name;
  fillSettings(profile.settings);
  fillLayout($("#connect-form"), profile.layout);
  $("#profile-name").value = profile.name;
  renderProfiles(state.snapshot.profiles);
  $("#connect-form").elements.password.focus();
}

async function saveProfileIfWanted(settings) {
  if (!$("#save-profile").checked) return;
  const name = $("#profile-name").value.trim() || (settings.protocol === "local" ? "Local server" : settings.host);
  if (!name) return;
  try {
    await api("POST", "/api/profiles", { name, settings, layout: formLayout($("#connect-form")) });
    state.activeProfile = name;
  } catch (_) {
    /* saving a profile is a convenience; never block connecting on it */
  }
}

let pendingTrust = null;

async function connect(extra = {}) {
  const settings = { ...formSettings(), ...extra };
  const snap = state.snapshot;
  if (snap && snap.has_password && !settings.password) {
    const initial = snap.settings || {};
    if (initial.host === settings.host && initial.username === settings.username) settings.use_initial = true;
  }
  $("#connect-error").hidden = true;
  $("#hostkey").hidden = true;
  try {
    logMark(`Connecting to ${settings.protocol === "local" ? settings.root || "run/" : settings.host}`);
    await runJob("/api/connect", { settings, layout: formLayout($("#connect-form")) }, { title: "Connecting" });
    await saveProfileIfWanted(settings);
    state.world = null;
    await refreshSnapshot();
  } catch (error) {
    if (error.code === "unknown_host_key") {
      const d = error.data;
      $("#hostkey-host").textContent = `${d.host}:${d.port}`;
      $("#hostkey-fp").textContent = `${d.key_type}  ${d.fingerprint}`;
      $("#hostkey").hidden = false;
      pendingTrust = { ...extra, trusted_fingerprint: d.fingerprint };
      $("#hostkey-trust").focus();
      return;
    }
    $("#connect-error").textContent = error.message;
    $("#connect-error").hidden = false;
  }
}

// ---- dashboard ----------------------------------------------------------------------------------------

async function refreshSnapshot({ reloadWorld = true } = {}) {
  const snap = await api("GET", "/api/state");
  state.snapshot = snap;
  renderProfiles(snap.profiles || []);
  $("#connect-view").hidden = snap.connected;
  $("#server-view").hidden = !snap.connected;
  if (!snap.connected) return;

  const settings = snap.settings || {};
  const proto = settings.protocol || "local";
  $("#conn-proto").textContent = PROTO_LABELS[proto] || proto;
  $("#conn-proto").className = `proto-tag ${proto}`;
  $("#conn-label").textContent = snap.label;
  renderUploads(snap.uploads || []);

  const worlds = snap.worlds || [];
  if (!worlds.some((w) => w.path === state.world)) state.world = snap.default_world || (worlds[0] && worlds[0].path) || null;
  renderWorlds();
  renderLayout(snap.layout);
  if (!state.world) return renderNoWorlds();
  if (reloadWorld) await loadWorld();
}

function renderWorlds() {
  const worlds = state.snapshot.worlds || [];
  const levelName = state.snapshot.layout && state.snapshot.layout.level_name;
  $("#world-count").textContent = worlds.length || "";
  $("#world-list").innerHTML = worlds.length
    ? worlds
        .map(
          (w) => `<button class="world ${w.path === state.world ? "active" : ""}" data-world="${esc(w.path)}">
            <span class="names"><span class="name">${esc(w.name)}</span><span class="sub">${esc(w.details || "empty")}</span></span>
            ${levelName && w.name === levelName ? '<span class="live" title="level-name in server.properties">LIVE</span>' : ""}
          </button>`,
        )
        .join("")
    : '<p class="empty-note">No worlds found. Use Edit layout… to point at the worlds folder.</p>';
}

function renderLayout(layout) {
  if (!layout) return;
  const rows = [];
  if (layout.single_world) rows.push(["World folder", layout.single_world]);
  else rows.push(["Worlds", layout.worlds_dir || "—"]);
  rows.push(["Behavior packs", layout.bp_dir || "inside the world"]);
  rows.push(["Resource packs", layout.rp_dir || "inside the world"]);
  if (layout.dev_bp_dir || layout.dev_rp_dir) rows.push(["Development", [layout.dev_bp_dir, layout.dev_rp_dir].filter(Boolean).join(", ")]);
  const scope = layout.pack_scope === "world" ? "The world's own folders" : "Shared server folders";
  $("#layout-dl").innerHTML =
    rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("") +
    `<div><dt>New packs go to</dt><dd class="plain">${esc(scope)}</dd></div>` +
    (layout.notes || []).map((note) => `<div><dd class="plain muted">${esc(note)}</dd></div>`).join("");
}

function renderNoWorlds() {
  $("#world-title").textContent = "No world selected";
  $("#world-meta").innerHTML = "";
  $("#pack-rows").innerHTML = '<tr><td colspan="5" class="empty">No worlds found. Use Edit layout… to point at the worlds folder.</td></tr>';
  $("#problems").innerHTML = "";
  $("#filter-chips").innerHTML = "";
}

async function loadWorld() {
  const world = (state.snapshot.worlds || []).find((w) => w.path === state.world);
  $("#world-title").textContent = world ? world.name : state.world;
  try {
    const job = await runJob("/api/status", { world: state.world }, { quiet: true, title: "Reading world" });
    state.status = job.result;
    state.selected.clear();
    state.beta = null;
    state.mode = null;
    renderStatus();
    if (state.planDirty || state.plan) previewInstall({ auto: true });
  } catch (error) {
    toast(error.message, true);
  }
}

const STATUS_LABELS = { ok: "Installed", missing: "Missing files", "version-mismatch": "Wrong version", unregistered: "Not registered" };
const FILTERS = [
  { id: "all", label: "All", color: "#c2c9bc" },
  { id: "ok", label: "Installed", color: "#8fd486" },
  { id: "version-mismatch", label: "Wrong version", color: "#f0cf86" },
  { id: "missing", label: "Missing", color: "#f59a8b" },
  { id: "unregistered", label: "Not registered", color: "#8ccaf0" },
];

function renderStatus() {
  const status = state.status;
  if (!status) return;
  const level = status.level || {};
  const rows = status.packs || [];
  const registered = (kind) => rows.filter((row) => row.kind === kind && row.registered).length;
  const meta = [];
  if (level.exists && !level.error) {
    meta.push(level.gamemode ? level.gamemode[0].toUpperCase() + level.gamemode.slice(1) : "Gamemode unknown");
    meta.push(level.beta ? "Beta APIs on" : "Beta APIs off");
  } else if (!level.exists) meta.push("No level.dat");
  meta.push(`${registered("bp")} behavior · ${registered("rp")} resource packs registered`);
  $("#world-meta").innerHTML = meta.map((m) => `<span>${esc(m)}</span>`).join("");
  $("#tab-count-packs").textContent = rows.length || "";

  const problems = status.problems || [];
  $("#problems").innerHTML = problems.length
    ? `<div class="banner warn">${icon.warn}<div><b>${problems.length} thing${problems.length === 1 ? "" : "s"} to look at.</b>${
        problems.length === 1 ? ` ${esc(problems[0])}` : `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
      }</div></div>`
    : "";

  const hidden = [];
  if (status.hidden_builtin) hidden.push(`${status.hidden_builtin} built-in game pack${status.hidden_builtin === 1 ? "" : "s"}`);
  (status.notes || []).forEach((note) => hidden.push(note));
  $("#hidden-section").hidden = !hidden.length;
  $("#hidden-list").innerHTML = hidden.map((item) => `<li>${esc(item)}</li>`).join("");

  renderChips();
  renderPackRows();
  renderLevel(level);
}

function renderChips() {
  const rows = (state.status && state.status.packs) || [];
  const count = (id) => (id === "all" ? rows.length : rows.filter((row) => row.status === id).length);
  $("#filter-chips").innerHTML = FILTERS.filter((f) => f.id === "all" || count(f.id))
    .map(
      (f) => `<button class="chip-btn ${state.filter === f.id ? "active" : ""}" data-filter="${f.id}" aria-pressed="${state.filter === f.id}">
        <span class="dot" style="background:${f.color}"></span>${esc(f.label)}<span class="n">${count(f.id)}</span></button>`,
    )
    .join("");
}

function visibleRows() {
  const rows = (state.status && state.status.packs) || [];
  const text = $("#pack-filter").value.trim().toLowerCase();
  return rows.filter(
    (row) => (state.filter === "all" || row.status === state.filter) && (!text || `${row.name} ${row.uuid} ${row.paths.join(" ")}`.toLowerCase().includes(text)),
  );
}

function renderPackRows() {
  const rows = (state.status && state.status.packs) || [];
  const visible = visibleRows();
  if (!visible.length) {
    $("#pack-rows").innerHTML = `<tr><td colspan="5" class="empty">${rows.length ? "Nothing matches the filter." : "No packs registered or installed for this world yet. Use Add packs to install some."}</td></tr>`;
    updateSelection();
    return;
  }
  $("#pack-rows").innerHTML = visible
    .map((row) => {
      const selected = row.flag && state.selected.has(row.flag);
      const check = row.flag ? `<input type="checkbox" class="pack-check" value="${esc(row.flag)}" ${selected ? "checked" : ""} aria-label="Select ${esc(row.name)}">` : "";
      const note = row.status === "version-mismatch" ? `<div class="version-note">server has ${esc(row.on_server_versions.join(", "))}</div>` : "";
      const scope = row.scope && row.scope !== "shared" ? ` <span class="scope">(${esc(row.scope === "world" ? "in world" : row.scope)})</span>` : "";
      const folders = row.paths.length ? row.paths.map(esc).join("<br>") : "—";
      return `<tr class="${selected ? "selected" : ""}">
        <td class="check">${check}</td>
        <td><div class="pack-name"><span class="kind ${esc(row.kind)}">${esc(row.kind.toUpperCase())}</span>${esc(row.name)}</div><div class="uuid">${esc(row.uuid)}</div></td>
        <td><span class="version">${esc(row.version_label)}</span>${note}</td>
        <td><span class="status ${esc(row.status)}">${esc(STATUS_LABELS[row.status] || row.status)}</span>${scope}</td>
        <td class="folder">${folders}</td>
      </tr>`;
    })
    .join("");
  updateSelection();
}

function updateSelection() {
  const count = state.selected.size;
  $("#selection-bar").hidden = count === 0;
  $("#selection-label").textContent = `${count} pack${count === 1 ? "" : "s"} selected`;
  const selectable = visibleRows().filter((row) => row.flag);
  $("#select-all").checked = selectable.length > 0 && selectable.every((row) => state.selected.has(row.flag));
}

function renderLevel(level) {
  const missing = !level || !level.exists || level.error;
  $("#level-missing").hidden = !missing;
  $("#level-missing").textContent = !level || !level.exists ? "This world has no level.dat, so there is nothing to change here." : `Could not read level.dat: ${level.error}`;
  $("#level-card").hidden = !!missing;
  $("#edit-btn").hidden = !!missing;
  if (missing) return;
  const beta = state.beta ?? !!level.beta;
  const switchEl = $("#beta-switch");
  switchEl.setAttribute("aria-checked", String(beta));
  switchEl.disabled = !!level.beta; // the tool only turns experiments on
  switchEl.title = level.beta ? "Already enabled" : "";
  const mode = state.mode ?? level.gamemode;
  $$("#gamemode-group button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mode === mode)));
  const changed = (state.beta !== null && state.beta !== !!level.beta) || (state.mode !== null && state.mode !== level.gamemode);
  $("#edit-btn").disabled = state.busy || !changed;
}

// ---- uploads & install ------------------------------------------------------------------------------

function renderUploads(uploads) {
  const names = new Set(uploads.map((u) => u.name));
  const pending = [...state.uploading.entries()].filter(([name]) => !names.has(name) || state.uploading.get(name).done < state.uploading.get(name).total);
  const items = [
    ...uploads.map((u) => {
      const progress = state.uploading.get(u.name);
      return { ...u, progress };
    }),
    ...pending.filter(([name]) => !names.has(name)).map(([name, progress]) => ({ name, is_dir: false, files: progress.total, size: 0, progress })),
  ];
  $("#tab-count-install").textContent = uploads.length || "";
  $("#upload-list").innerHTML = items
    .map((u) => {
      const p = u.progress;
      const pct = p ? Math.round((p.done / Math.max(1, p.total)) * 100) : 100;
      const meta = p && p.done < p.total ? `${p.done}/${p.total} files` : `${u.is_dir ? `folder · ${u.files} files · ` : ""}${formatBytes(u.size)}`;
      return `<li><div class="q-row"><span class="q-name">${esc(u.name)}</span><span class="q-meta">${esc(meta)}</span>
        <button class="icon-btn" data-remove="${esc(u.name)}" aria-label="Remove ${esc(u.name)}">${icon.close}</button></div>
        <div class="bar ${pct >= 100 ? "done" : ""}"><div style="width:${pct}%"></div></div></li>`;
    })
    .join("");
  updateInstallButtons();
}

function uploadCount() {
  return ((state.snapshot && state.snapshot.uploads) || []).length;
}

function updateInstallButtons() {
  const has = uploadCount() > 0;
  const uploads = state.plan && !state.planDirty ? state.plan.plan.filter((item) => item.action !== "skip").length : 0;
  $("#preview-btn").disabled = state.busy || !has;
  $("#clear-uploads").disabled = state.busy || !has;
  $("#install-btn").disabled = state.busy || !has || !state.plan || state.planDirty || uploads === 0;
  $("#install-btn").textContent = uploads ? `Install ${uploads} pack${uploads === 1 ? "" : "s"}` : "Install";
}

function walkEntry(entry, prefix = "") {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => resolve([{ file, path: prefix + file.name }]),
        () => resolve([]),
      );
      return;
    }
    if (!entry.isDirectory) return resolve([]);
    const reader = entry.createReader();
    const all = [];
    const readBatch = () =>
      reader.readEntries(
        async (batch) => {
          if (!batch.length) {
            const nested = await Promise.all(all.map((child) => walkEntry(child, `${prefix}${entry.name}/`)));
            resolve(nested.flat());
            return;
          }
          all.push(...batch);
          readBatch();
        },
        () => resolve([]),
      );
    readBatch();
  });
}

async function uploadFiles(items) {
  items = items.filter((item) => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/.test(item.path));
  if (!items.length) return;
  switchTab("install");
  for (const item of items) {
    const top = item.path.split("/")[0];
    const entry = state.uploading.get(top) || { done: 0, total: 0 };
    entry.total += 1;
    state.uploading.set(top, entry);
  }
  renderUploads(state.snapshot.uploads || []);
  setConsole("busy", "Adding packs", `${items.length} file(s)`);
  let failed = null;
  // Local uploads are quick; a few at a time keeps big folders snappy without flooding the server.
  const queue = [...items];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length && !failed) {
      const { file, path } = queue.shift();
      try {
        await api("PUT", `/api/uploads?path=${encodeURIComponent(path)}`, file, { "Content-Type": "application/octet-stream" });
      } catch (error) {
        failed = error;
        return;
      }
      state.uploading.get(path.split("/")[0]).done += 1;
      renderUploads(state.snapshot.uploads || []);
    }
  });
  await Promise.all(workers);
  state.uploading.clear();
  const { uploads } = await api("GET", "/api/uploads");
  state.snapshot.uploads = uploads;
  renderUploads(uploads);
  if (failed) {
    setConsole("error", "Adding packs failed", failed.message);
    toast(`Upload failed: ${failed.message}`, true);
    return;
  }
  setConsole("ok", "Packs added", `${items.length} file(s)`);
  state.planDirty = true;
  previewInstall({ auto: true });
}

function renderPlan(result, applied) {
  const plan = result.plan || [];
  const counts = { upload: 0, replace: 0, register: 0, skip: 0 };
  const items = plan.map((item) => {
    const kind = item.action === "upload" && item.replace.length ? "replace" : item.action;
    counts[kind] += 1;
    return { ...item, kind };
  });
  const labels = { upload: "Upload", replace: "Replace", register: "Register", skip: "Skip" };
  $("#plan-counts").innerHTML = Object.entries(counts)
    .filter(([, n]) => n)
    .map(([kind, n]) => `<span class="c-${kind}">${n} ${labels[kind].toLowerCase()}</span>`)
    .join("");
  $("#plan-sub").textContent = applied
    ? `Done — installed ${result.stats.installed}, skipped ${result.stats.skipped}, errors ${result.stats.errors}`
    : "Nothing changes until you install";
  if (!items.length) {
    $("#plan").innerHTML = '<p class="plan-empty">No installable packs were found in what you added. The activity log says why.</p>';
    return;
  }
  $("#plan").innerHTML = items
    .map(
      (item) => `<div class="plan-item"><span class="action ${item.kind}">${labels[item.kind]}</span>
        <div class="names">
          <div><b>${esc(item.name)}</b> <span class="muted small">v${esc(item.version_label)} · ${esc(item.kind === "skip" ? item.source : item.kind === "register" ? "already on server" : item.source)}</span></div>
          <div class="reason">${esc(item.reason)}</div>
          ${item.target ? `<div class="target">→ ${esc(item.target)}</div>` : ""}
          ${item.replace.map((path) => `<div class="target">removes ${esc(path)}</div>`).join("")}
        </div></div>`,
    )
    .join("");
}

function clearPlan() {
  state.plan = null;
  state.planDirty = false;
  $("#plan-counts").innerHTML = "";
  $("#plan-sub").textContent = "Nothing changes until you install";
  $("#plan").innerHTML = '<p class="plan-empty">Add packs on the left to see exactly what will be uploaded, replaced, or only registered.</p>';
  updateInstallButtons();
}

async function previewInstall({ auto = false } = {}) {
  if (!state.world || !uploadCount()) return clearPlan();
  if (state.busy) return;
  try {
    if (!auto) logMark("Previewing install");
    const job = await runJob(
      "/api/install",
      { world: state.world, duplicate_mode: $("#duplicate-mode").value, reupload: $("#reupload").checked, dry_run: true },
      { quiet: auto, title: "Planning install" },
    );
    state.plan = job.result;
    state.planDirty = false;
    renderPlan(job.result, false);
  } catch (error) {
    toast(error.message, true);
  }
  updateInstallButtons();
}

async function install() {
  const actions = state.plan.plan.filter((item) => item.action !== "skip");
  const ok = await confirmDialog(
    `Install ${actions.length} pack${actions.length === 1 ? "" : "s"}?`,
    `<p>Into <b>${esc(state.status ? state.status.world_name : state.world)}</b> on <code>${esc(state.snapshot.label)}</code>.</p>`,
    "Install",
  );
  if (!ok) return;
  try {
    logMark("Installing");
    const job = await runJob(
      "/api/install",
      { world: state.world, duplicate_mode: $("#duplicate-mode").value, reupload: $("#reupload").checked, dry_run: false },
      { title: `Installing ${actions.length} pack${actions.length === 1 ? "" : "s"}` },
    );
    renderPlan(job.result, true);
    state.plan = null;
    const errors = job.result.stats.errors;
    toast(errors ? "Installed with errors — see the activity log" : "Installed", errors > 0);
    await refreshSnapshot();
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- other actions ------------------------------------------------------------------------------------

async function simpleJob(path, body, title, successMessage) {
  try {
    logMark(title);
    const job = await runJob(path, body, { title });
    if (successMessage) toast(successMessage);
    return job;
  } catch (error) {
    toast(error.message, true);
    return null;
  }
}

async function uninstall(keepFiles) {
  const flags = [...state.selected];
  if (!flags.length) return;
  const names = (state.status.packs || []).filter((row) => flags.includes(row.flag)).map((row) => `<li>${esc(row.name)} <span class="muted">v${esc(row.version_label)}</span></li>`);
  const ok = await confirmDialog(
    keepFiles ? `Remove ${flags.length} pack(s) from this world?` : `Uninstall ${flags.length} pack(s)?`,
    `<ul>${names.join("")}</ul><p>${
      keepFiles
        ? "They are removed from this world's pack lists. Their folders stay on the server."
        : "They are removed from this world, and their folders deleted unless another world still uses them."
    }</p>`,
    keepFiles ? "Remove" : "Uninstall",
    !keepFiles,
  );
  if (!ok) return;
  if (await simpleJob("/api/uninstall", { world: state.world, flags, keep_files: keepFiles }, "Uninstalling", "Done")) await refreshSnapshot();
}

async function cleanup() {
  const preview = await simpleJob("/api/cleanup", { world: state.world, dry_run: true }, "Previewing cleanup");
  if (!preview) return;
  const folders = preview.result.deleted;
  if (!folders.length) return toast("Nothing to clean up");
  const ok = await confirmDialog(
    `Delete ${folders.length} unused pack folder(s)?`,
    `<ul>${folders.map((f) => `<li><code>${esc(f)}</code></li>`).join("")}</ul><p>No world registers these. Built-in game packs and development folders are never touched.</p>`,
    "Delete folders",
    true,
  );
  if (!ok) return;
  if (await simpleJob("/api/cleanup", { world: state.world, dry_run: false }, "Cleaning up", "Cleanup done")) await refreshSnapshot();
}

async function rebuild() {
  const ok = await confirmDialog(
    "Rebuild world pack JSONs?",
    "<p>This overwrites <code>world_behavior_packs.json</code> and <code>world_resource_packs.json</code> for this world with every pack found on the server. Packs that are listed but missing are dropped.</p>",
    "Rebuild",
    true,
  );
  if (!ok) return;
  if (await simpleJob("/api/rebuild", { world: state.world }, "Rebuilding JSONs", "Rebuilt")) await refreshSnapshot();
}

async function editWorld() {
  const level = state.status.level || {};
  const beta = state.beta === true && !level.beta;
  const gamemode = state.mode && state.mode !== level.gamemode ? state.mode : null;
  if (!beta && !gamemode) return;
  const ok = await confirmDialog(
    "Change level.dat?",
    "<p>Make sure the server is <b>stopped</b>, otherwise it may overwrite the change. The current file is kept as <code>level.dat.backup</code>.</p>",
    "Save",
  );
  if (!ok) return;
  if (await simpleJob("/api/edit", { world: state.world, beta, gamemode }, "Saving world settings", "World updated")) await loadWorld();
}

async function backup(worldOnly) {
  const job = await simpleJob("/api/backup", { world: worldOnly ? state.world : null }, worldOnly ? "Backing up world" : "Backing up everything");
  if (!job) return;
  const result = job.result;
  const href = `${result.download}?t=${encodeURIComponent(TOKEN)}`;
  $("#backup-result").innerHTML = `${esc(result.file_count)} files, ${esc(result.size_mb)} MB — <a href="${esc(href)}" download>Download ${esc(result.zip_name)}</a>`;
  const link = document.createElement("a");
  link.href = href;
  link.download = result.zip_name;
  link.click();
  toast("Backup downloading");
}

function switchTab(name) {
  $$(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  $$(".panel").forEach((panel) => (panel.hidden = panel.dataset.panel !== name));
}

// ---- wiring ------------------------------------------------------------------------------------------

function wireConnect() {
  $$("#connect-form input[name=protocol]").forEach((radio) => radio.addEventListener("change", syncProtocolFields));
  $("#connect-form").addEventListener("submit", (event) => {
    event.preventDefault();
    connect();
  });
  $("#profile-list").addEventListener("click", async (event) => {
    const del = event.target.closest("[data-delete]");
    if (del) {
      event.stopPropagation();
      const { profiles } = await api("DELETE", `/api/profiles?name=${encodeURIComponent(del.dataset.delete)}`);
      state.snapshot.profiles = profiles;
      if (state.activeProfile === del.dataset.delete) state.activeProfile = null;
      renderProfiles(profiles);
      return;
    }
    const profile = event.target.closest("[data-profile]");
    if (profile) pickProfile(profile.dataset.profile);
  });
  $("#profile-list").addEventListener("keydown", (event) => {
    const profile = event.target.closest("[data-profile]");
    if (profile && (event.key === "Enter" || event.key === " ") && event.target === profile) {
      event.preventDefault();
      pickProfile(profile.dataset.profile);
    }
  });
  $("#new-server").addEventListener("click", () => {
    state.activeProfile = null;
    fillSettings({ protocol: "sftp" });
    fillLayout($("#connect-form"), {});
    $("#profile-name").value = "";
    renderProfiles(state.snapshot.profiles || []);
    $("#connect-form").elements.host.focus();
  });
  $("#hostkey-trust").addEventListener("click", () => {
    const extra = pendingTrust;
    pendingTrust = null;
    $("#hostkey").hidden = true;
    if (extra) connect(extra);
  });
  $("#hostkey-cancel").addEventListener("click", () => {
    pendingTrust = null;
    $("#hostkey").hidden = true;
    logMark("Host key not trusted — connection cancelled");
  });
}

function wireDashboard() {
  $("#disconnect-btn").addEventListener("click", async () => {
    try {
      await api("POST", "/api/disconnect", {});
      state.status = null;
      clearPlan();
      setConsole("", "Idle");
      await refreshSnapshot();
    } catch (error) {
      toast(error.message, true);
    }
  });
  $("#world-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-world]");
    if (!button || state.busy || button.dataset.world === state.world) return;
    state.world = button.dataset.world;
    $("#backup-result").innerHTML = "";
    renderWorlds();
    loadWorld();
  });
  $("#layout-btn").addEventListener("click", async () => {
    fillLayout($("#layout-form"), state.snapshot.overrides);
    if (!(await showDialog($("#layout-dialog")))) return;
    if (await simpleJob("/api/layout", { layout: formLayout($("#layout-form")) }, "Updating layout", "Layout updated")) await refreshSnapshot();
  });
  $("#add-packs").addEventListener("click", () => switchTab("install"));
  $("#top-backup").addEventListener("click", () => backup(true));
  $$(".tabs button").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));

  // packs
  $("#filter-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-filter]");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderChips();
    renderPackRows();
  });
  $("#pack-filter").addEventListener("input", renderPackRows);
  $("#pack-rows").addEventListener("change", (event) => {
    if (!event.target.classList.contains("pack-check")) return;
    if (event.target.checked) state.selected.add(event.target.value);
    else state.selected.delete(event.target.value);
    event.target.closest("tr").classList.toggle("selected", event.target.checked);
    updateSelection();
  });
  $("#select-all").addEventListener("change", (event) => {
    visibleRows()
      .filter((row) => row.flag)
      .forEach((row) => (event.target.checked ? state.selected.add(row.flag) : state.selected.delete(row.flag)));
    renderPackRows();
  });
  $("#clear-selection").addEventListener("click", () => {
    state.selected.clear();
    renderPackRows();
  });
  $("#remove-only").addEventListener("click", () => uninstall(true));
  $("#uninstall-btn").addEventListener("click", () => uninstall(false));

  // install
  const dropzone = $("#dropzone");
  ["dragenter", "dragover"].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((type) => dropzone.addEventListener(type, () => dropzone.classList.remove("over")));
  const handleDrop = async (event) => {
    event.preventDefault();
    dropzone.classList.remove("over");
    // Entries must be read synchronously, before the first await.
    const entries = Array.from(event.dataTransfer.items || [])
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);
    const files = Array.from(event.dataTransfer.files || []);
    if (entries.length) {
      const nested = await Promise.all(entries.map((entry) => walkEntry(entry)));
      await uploadFiles(nested.flat());
    } else {
      await uploadFiles(files.map((file) => ({ file, path: file.name })));
    }
  };
  // Dropping anywhere on the dashboard works, not only on the drop zone.
  $("#server-view").addEventListener("dragover", (event) => {
    if (event.dataTransfer && [...event.dataTransfer.types].includes("Files")) event.preventDefault();
  });
  $("#server-view").addEventListener("drop", (event) => {
    if (event.dataTransfer && event.dataTransfer.files.length) handleDrop(event);
  });
  $("#pick-files").addEventListener("click", () => $("#file-input").click());
  $("#pick-folder").addEventListener("click", () => $("#folder-input").click());
  $("#file-input").addEventListener("change", async (event) => {
    await uploadFiles(Array.from(event.target.files).map((file) => ({ file, path: file.name })));
    event.target.value = "";
  });
  $("#folder-input").addEventListener("change", async (event) => {
    await uploadFiles(Array.from(event.target.files).map((file) => ({ file, path: file.webkitRelativePath || file.name })));
    event.target.value = "";
  });
  $("#upload-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button) return;
    const { uploads } = await api("DELETE", `/api/uploads?name=${encodeURIComponent(button.dataset.remove)}`);
    state.snapshot.uploads = uploads;
    renderUploads(uploads);
    state.planDirty = true;
    previewInstall({ auto: true });
  });
  $("#clear-uploads").addEventListener("click", async () => {
    const { uploads } = await api("DELETE", "/api/uploads");
    state.snapshot.uploads = uploads;
    renderUploads(uploads);
    clearPlan();
  });
  ["duplicate-mode", "reupload"].forEach((id) =>
    $(`#${id}`).addEventListener("change", () => {
      state.planDirty = true;
      previewInstall({ auto: true });
    }),
  );
  $("#preview-btn").addEventListener("click", () => previewInstall());
  $("#install-btn").addEventListener("click", install);

  // world
  $("#beta-switch").addEventListener("click", () => {
    const level = state.status.level || {};
    state.beta = !(state.beta ?? !!level.beta);
    renderLevel(level);
  });
  $("#gamemode-group").addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (!button) return;
    state.mode = button.dataset.mode;
    renderLevel(state.status.level || {});
  });
  $("#edit-btn").addEventListener("click", editWorld);

  // tools
  $("#doctor-btn").addEventListener("click", async () => {
    const job = await simpleJob("/api/doctor", { world: state.world }, "Auditing");
    if (!job) return;
    state.status = job.result;
    renderStatus();
    toast(job.warnings.length ? `Audit found ${job.warnings.length} issue(s)` : "Audit clean", job.warnings.length > 0);
  });
  $("#rebuild-btn").addEventListener("click", rebuild);
  $("#cleanup-btn").addEventListener("click", cleanup);
  $("#backup-world-btn").addEventListener("click", () => backup(true));
  $("#backup-all-btn").addEventListener("click", () => backup(false));

  // console
  $("#clear-log").addEventListener("click", () => ($("#log").textContent = ""));
  $("#copy-log").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#log").textContent);
      toast("Log copied");
    } catch (_) {
      toast("Could not copy the log", true);
    }
  });
  $("#toggle-console").addEventListener("click", (event) => {
    const dock = event.target.closest(".console");
    const collapsed = dock.classList.toggle("collapsed");
    event.target.textContent = collapsed ? "Show" : "Hide";
    event.target.setAttribute("aria-expanded", String(!collapsed));
  });
}

async function init() {
  wireConnect();
  wireDashboard();
  syncProtocolFields();
  if (!TOKEN) {
    $("#connect-error").textContent = "Missing access token. Open the full link printed in the terminal.";
    $("#connect-error").hidden = false;
    return;
  }
  try {
    await refreshSnapshot();
    const snap = state.snapshot;
    if (!snap.connected) {
      if (snap.settings) {
        fillSettings(snap.settings);
        if (snap.has_password) $("#connect-form").elements.password.placeholder = "Using the password from the command line";
      } else if ((snap.profiles || []).length) {
        pickProfile(snap.profiles[0].name);
      }
    }
  } catch (error) {
    $("#connect-error").textContent = error.message;
    $("#connect-error").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", init);
