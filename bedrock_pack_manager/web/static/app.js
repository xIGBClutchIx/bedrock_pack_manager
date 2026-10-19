"use strict";

const TOKEN = new URLSearchParams(location.search).get("t") || "";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  snapshot: null,
  world: null,
  status: null,
  busy: false,
};

// ---- helpers ----------------------------------------------------------------------------------

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

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

function log(line) {
  const pre = $("#log");
  pre.textContent += line + "\n";
  pre.scrollTop = pre.scrollHeight;
}

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
  $("#busy").hidden = !busy;
  $$("main button").forEach((button) => {
    if (button.id === "clear-log") return;
    if (busy) {
      button.dataset.wasDisabled = button.disabled ? "1" : "";
      button.disabled = true;
    } else {
      button.disabled = button.dataset.wasDisabled === "1";
    }
  });
  if (!busy) updateUninstallButton();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a server job, stream its console lines into the activity log, and resolve with the job. */
async function runJob(path, body, { quiet = false } = {}) {
  if (state.busy) throw new Error("Another task is running");
  setBusy(true);
  try {
    const { job: id } = await api("POST", path, body);
    let since = 0;
    for (;;) {
      const job = await api("GET", `/api/jobs/${id}?since=${since}`);
      if (!quiet || job.status === "error") job.lines.forEach(log);
      since = job.next;
      if (job.status !== "running") {
        if (job.status === "error") {
          const error = new Error(job.error || "Task failed");
          error.code = job.error_code;
          error.data = job.error_data;
          throw error;
        }
        return job;
      }
      await sleep(job.lines.length ? 150 : 400);
    }
  } finally {
    setBusy(false);
  }
}

function confirmDialog(title, html, okLabel = "Continue", danger = false) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-body").innerHTML = html;
  const ok = $("#confirm-ok");
  ok.textContent = okLabel;
  ok.className = danger ? "danger" : "primary";
  return showDialog(dialog);
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

// ---- connect -------------------------------------------------------------------------------------

const DEFAULT_PORTS = { ftp: "21", ftps: "21", sftp: "22" };

function protocol() {
  return $("#connect-form").elements.protocol.value;
}

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
  form.elements.root.placeholder =
    proto === "local" ? "Empty uses the bundled run/ folder, or e.g. C:\\bedrock-server" : "Leave empty for the login folder, e.g. /home/container or bedrock";
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
  if (!settings) return;
  const f = $("#connect-form").elements;
  const proto = settings.protocol || "sftp";
  $(`#connect-form input[name=protocol][value="${proto}"]`).checked = true;
  f.host.value = settings.host || "";
  f.port.value = settings.port || "";
  f.username.value = settings.username || "";
  f.root.value = settings.root || "";
  f.key_file.value = settings.key_file || "";
  f.allow_self_signed.checked = settings.tls_verify === false;
  f.active_mode.checked = settings.passive === false;
  f.password.value = "";
  syncProtocolFields();
}

function renderProfiles(profiles) {
  const select = $("#profile-select");
  const current = select.value;
  select.innerHTML = '<option value="">Saved profiles…</option>' + profiles.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
  if (profiles.some((p) => p.name === current)) select.value = current;
}

async function connect(extra = {}) {
  const settings = { ...formSettings(), ...extra };
  if (state.snapshot && state.snapshot.has_password && !settings.password && !extra.use_initial) {
    const initial = state.snapshot.settings || {};
    if (initial.host === settings.host && initial.username === settings.username) settings.use_initial = true;
  }
  try {
    log(`— Connecting to ${settings.protocol === "local" ? settings.root || "run/" : settings.host} —`);
    await runJob("/api/connect", { settings, layout: formLayout($("#connect-form")) });
    await refreshSnapshot();
    toast("Connected");
  } catch (error) {
    if (error.code === "unknown_host_key") {
      const d = error.data;
      const trusted = await confirmDialog(
        "Trust this server?",
        `<p>This is the first connection to <b>${esc(d.host)}:${esc(d.port)}</b>. Check that the host key matches what your host shows:</p>
         <p><code>${esc(d.key_type)} ${esc(d.fingerprint)}</code></p>
         <p class="muted">It will be remembered in run/known_hosts.</p>`,
        "Trust and connect",
      );
      if (trusted) return connect({ ...extra, trusted_fingerprint: d.fingerprint, use_initial: settings.use_initial });
      log("Host key not trusted - connection cancelled");
      return;
    }
    toast(error.message, true);
  }
}

// ---- snapshot & world -----------------------------------------------------------------------------

async function refreshSnapshot() {
  const snap = await api("GET", "/api/state");
  state.snapshot = snap;
  renderProfiles(snap.profiles || []);
  renderUploads(snap.uploads || []);

  $("#conn-badge").textContent = snap.connected ? "Connected" : "Offline";
  $("#conn-badge").classList.toggle("online", snap.connected);
  $("#conn-label").textContent = snap.connected ? snap.label : "Not connected";
  $("#disconnect-btn").hidden = !snap.connected;
  $("#connect-view").hidden = snap.connected;
  $("#server-view").hidden = !snap.connected;

  if (!snap.connected) return;

  const select = $("#world-select");
  const worlds = snap.worlds || [];
  if (!worlds.some((w) => w.path === state.world)) state.world = snap.default_world || (worlds[0] && worlds[0].path) || null;
  select.innerHTML = worlds.length
    ? worlds.map((w) => `<option value="${esc(w.path)}">${esc(w.name)}${w.details ? " — " + esc(w.details) : ""}</option>`).join("")
    : '<option value="">No worlds found</option>';
  if (state.world) select.value = state.world;
  renderLayoutSummary(snap.layout);
  if (state.world) await loadWorld();
  else renderNoWorlds();
}

function renderLayoutSummary(layout) {
  if (!layout) return;
  const parts = [`Server folder <b>${esc(layout.server_root || ".")}</b>`];
  if (layout.single_world) parts.push("single world");
  else parts.push(`worlds <b>${esc(layout.worlds_dir || "—")}</b>`);
  if (layout.bp_dir) parts.push(`BP <b>${esc(layout.bp_dir)}</b>`);
  if (layout.rp_dir) parts.push(`RP <b>${esc(layout.rp_dir)}</b>`);
  if (layout.dev_bp_dir || layout.dev_rp_dir) parts.push("dev folders found");
  let html = parts.join(" · ");
  if (layout.notes && layout.notes.length) html += `<br>${layout.notes.map(esc).join("<br>")}`;
  $("#layout-summary").innerHTML = html;
}

function renderNoWorlds() {
  $("#pack-rows").innerHTML = '<tr><td colspan="6" class="empty">No worlds found. Check the folder or use Layout… to point at the worlds folder.</td></tr>';
  $("#problems").innerHTML = "";
}

async function loadWorld() {
  try {
    const job = await runJob("/api/status", { world: state.world }, { quiet: true });
    state.status = job.result;
    renderStatus();
  } catch (error) {
    toast(error.message, true);
  }
}

const STATUS_LABELS = { ok: "Installed", missing: "Missing files", "version-mismatch": "Wrong version", unregistered: "Not registered" };

function renderStatus() {
  const status = state.status;
  if (!status) return;
  const problems = status.problems || [];
  $("#problems").innerHTML = problems.length
    ? `<div class="notice warn"><b>${problems.length} thing(s) to look at</b><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`
    : "";
  renderPackRows();
  renderLevel(status.level);
}

function renderPackRows() {
  const rows = (state.status && state.status.packs) || [];
  const text = $("#pack-filter").value.trim().toLowerCase();
  const statusFilter = $("#status-filter").value;
  const visible = rows.filter(
    (row) => (!statusFilter || row.status === statusFilter) && (!text || `${row.name} ${row.uuid} ${row.paths.join(" ")}`.toLowerCase().includes(text)),
  );
  $("#select-all").checked = false;
  if (!visible.length) {
    $("#pack-rows").innerHTML = `<tr><td colspan="6" class="empty">${rows.length ? "Nothing matches the filter." : "No packs registered or installed for this world yet."}</td></tr>`;
    updateUninstallButton();
    return;
  }
  $("#pack-rows").innerHTML = visible
    .map((row) => {
      const check = row.flag ? `<input type="checkbox" class="pack-check" value="${esc(row.flag)}" aria-label="Select ${esc(row.name)}">` : "";
      const versions = row.status === "version-mismatch" ? `<span class="sub">on server: ${esc(row.on_server_versions.join(", "))}</span>` : "";
      const scope = row.scope && row.scope !== "shared" ? ` <span class="muted">(${esc(row.scope)})</span>` : "";
      return `<tr>
        <td class="check">${check}</td>
        <td><span class="kind ${esc(row.kind)}">${esc(row.kind.toUpperCase())}</span></td>
        <td>${esc(row.name)}<span class="sub">${esc(row.uuid)}</span></td>
        <td>${esc(row.version_label)}${versions}</td>
        <td><span class="chip ${esc(row.status)}">${esc(STATUS_LABELS[row.status] || row.status)}</span>${scope}</td>
        <td class="path">${row.paths.map(esc).join("<br>") || "—"}</td>
      </tr>`;
    })
    .join("");
  updateUninstallButton();
}

function selectedFlags() {
  return $$(".pack-check:checked").map((el) => el.value);
}

function updateUninstallButton() {
  const count = selectedFlags().length;
  const button = $("#uninstall-btn");
  button.disabled = state.busy || count === 0;
  button.textContent = count ? `Uninstall ${count} selected` : "Uninstall selected";
}

function renderLevel(level) {
  const facts = $("#level-facts");
  if (!level || !level.exists) {
    facts.innerHTML = "<dt>level.dat</dt><dd>Not found in this world folder</dd>";
    return;
  }
  if (level.error) {
    facts.innerHTML = `<dt>level.dat</dt><dd>Could not read it: ${esc(level.error)}</dd>`;
    return;
  }
  facts.innerHTML = `
    <dt>Level name</dt><dd>${esc(level.level_name || "—")}</dd>
    <dt>Beta APIs</dt><dd>${level.beta ? "Enabled" : "Off"}</dd>
    <dt>Gamemode</dt><dd>${esc(level.gamemode ? level.gamemode[0].toUpperCase() + level.gamemode.slice(1) : "—")}</dd>`;
  $("#edit-beta").checked = false;
  $("#edit-beta").disabled = !!level.beta;
}

// ---- uploads -------------------------------------------------------------------------------------

function renderUploads(uploads) {
  const list = $("#upload-list");
  list.innerHTML = uploads
    .map(
      (u) => `<li><span><span class="name">${u.is_dir ? "📁 " : ""}${esc(u.name)}</span>
        <span class="meta"> ${u.is_dir ? `${u.files} files, ` : ""}${formatBytes(u.size)}</span></span>
        <button class="ghost small" data-remove="${esc(u.name)}">Remove</button></li>`,
    )
    .join("");
  $("#install-btn").disabled = state.busy || uploads.length === 0;
  $("#preview-btn").disabled = state.busy || uploads.length === 0;
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
      reader.readEntries(async (batch) => {
        if (!batch.length) {
          const nested = await Promise.all(all.map((child) => walkEntry(child, `${prefix}${entry.name}/`)));
          resolve(nested.flat());
          return;
        }
        all.push(...batch);
        readBatch();
      }, () => resolve([]));
    readBatch();
  });
}

async function uploadFiles(items) {
  items = items.filter((item) => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/.test(item.path));
  if (!items.length) return;
  const total = items.reduce((sum, item) => sum + item.file.size, 0);
  const bar = $("#upload-progress");
  bar.hidden = false;
  let done = 0;
  try {
    for (let i = 0; i < items.length; i++) {
      const { file, path } = items[i];
      $("span", bar).textContent = `Adding ${i + 1}/${items.length}: ${path}`;
      await api("PUT", `/api/uploads?path=${encodeURIComponent(path)}`, file, { "Content-Type": "application/octet-stream" });
      done += file.size;
      $("div", bar).style.width = `${total ? (done / total) * 100 : 100}%`;
    }
  } catch (error) {
    toast(`Upload failed: ${error.message}`, true);
  } finally {
    bar.hidden = true;
    $("div", bar).style.width = "0";
    const { uploads } = await api("GET", "/api/uploads");
    renderUploads(uploads);
    $("#plan").innerHTML = "";
  }
}

// ---- install ------------------------------------------------------------------------------------

const ACTION_LABELS = { upload: "Upload", register: "Register only", skip: "Skip" };

function renderPlan(result, applied) {
  const plan = result.plan || [];
  if (!plan.length) {
    $("#plan").innerHTML = '<div class="notice warn">No installable packs were found in what you added. See the activity log for details.</div>';
    return;
  }
  const counts = plan.reduce((acc, item) => ((acc[item.action] = (acc[item.action] || 0) + 1), acc), {});
  const summary = applied
    ? `Done — installed ${result.stats.installed}, skipped ${result.stats.skipped}, errors ${result.stats.errors}.`
    : `Preview — ${counts.upload || 0} to upload, ${counts.register || 0} to register, ${counts.skip || 0} to skip. Nothing has changed yet.`;
  $("#plan").innerHTML = `<p class="plan-summary">${esc(summary)}</p>
    <div class="table-wrap"><table><thead><tr><th>Type</th><th>Pack</th><th>Action</th><th>Details</th></tr></thead><tbody>
    ${plan
      .map(
        (item) => `<tr>
        <td><span class="kind ${esc(item.kind)}">${esc(item.kind.toUpperCase())}</span></td>
        <td>${esc(item.name)} <span class="muted">v${esc(item.version_label)}</span><span class="sub">${esc(item.source)}</span></td>
        <td><span class="chip ${esc(item.action)}">${esc(ACTION_LABELS[item.action] || item.action)}</span></td>
        <td>${esc(item.reason)}${item.target ? `<span class="sub">→ ${esc(item.target)}</span>` : ""}${item.replace
          .map((p) => `<span class="sub">removes ${esc(p)}</span>`)
          .join("")}</td></tr>`,
      )
      .join("")}
    </tbody></table></div>`;
}

async function install(dryRun) {
  if (!state.world) return toast("Pick a world first", true);
  const body = {
    world: state.world,
    duplicate_mode: $("#duplicate-mode").value,
    reupload: $("#reupload").checked,
    dry_run: dryRun,
  };
  try {
    log(dryRun ? "— Previewing install —" : "— Installing —");
    const job = await runJob("/api/install", body);
    renderPlan(job.result, !dryRun);
    if (!dryRun) {
      toast(job.result.stats.errors ? "Installed with errors - see the log" : "Installed", job.result.stats.errors > 0);
      await refreshSnapshot();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

// ---- other actions --------------------------------------------------------------------------------

async function simpleJob(path, body, successMessage) {
  try {
    const job = await runJob(path, body);
    if (successMessage) toast(successMessage);
    return job;
  } catch (error) {
    toast(error.message, true);
    return null;
  }
}

async function uninstall() {
  const flags = selectedFlags();
  if (!flags.length) return;
  const keep = $("#keep-files").checked;
  const names = (state.status.packs || []).filter((row) => flags.includes(row.flag)).map((row) => `<li>${esc(row.name)} v${esc(row.version_label)}</li>`);
  const ok = await confirmDialog(
    `Uninstall ${flags.length} pack(s)?`,
    `<ul>${names.join("")}</ul><p>${
      keep ? "They will be removed from this world's pack lists. Files stay on the server." : "They will be removed from this world, and their folders deleted unless another world still uses them."
    }</p>`,
    "Uninstall",
    !keep,
  );
  if (!ok) return;
  log("— Uninstalling —");
  if (await simpleJob("/api/uninstall", { world: state.world, flags, keep_files: keep }, "Uninstalled")) await loadWorld();
}

async function cleanup() {
  log("— Previewing cleanup —");
  const preview = await simpleJob("/api/cleanup", { world: state.world, dry_run: true });
  if (!preview) return;
  const folders = preview.result.deleted;
  if (!folders.length) return toast("Nothing to clean up");
  const ok = await confirmDialog(
    `Delete ${folders.length} unused pack folder(s)?`,
    `<ul>${folders.map((f) => `<li><code>${esc(f)}</code></li>`).join("")}</ul><p>These are not registered in this world and no other world uses them.</p>`,
    "Delete folders",
    true,
  );
  if (!ok) return;
  log("— Cleaning up —");
  if (await simpleJob("/api/cleanup", { world: state.world, dry_run: false }, "Cleanup done")) await loadWorld();
}

async function rebuild() {
  const ok = await confirmDialog(
    "Rebuild world pack JSONs?",
    "<p>This overwrites <code>world_behavior_packs.json</code> and <code>world_resource_packs.json</code> for this world with every pack found on the server. Packs that are only listed but missing will be dropped.</p>",
    "Rebuild",
    true,
  );
  if (!ok) return;
  log("— Rebuilding JSONs —");
  if (await simpleJob("/api/rebuild", { world: state.world }, "Rebuilt")) await loadWorld();
}

async function editWorld() {
  const beta = $("#edit-beta").checked;
  const gamemode = $("#edit-gamemode").value;
  if (!beta && !gamemode) return toast("Choose a change first", true);
  const ok = await confirmDialog(
    "Change level.dat?",
    "<p>Make sure the server is <b>stopped</b>, otherwise it may overwrite the change. A backup is saved as <code>level.dat.backup</code>.</p>",
    "Apply",
  );
  if (!ok) return;
  log("— Editing world —");
  if (await simpleJob("/api/edit", { world: state.world, beta, gamemode: gamemode || null }, "World updated")) {
    $("#edit-gamemode").value = "";
    await loadWorld();
  }
}

async function backup(worldOnly) {
  log(worldOnly ? "— Backing up this world —" : "— Backing up everything —");
  const job = await simpleJob("/api/backup", { world: worldOnly ? state.world : null });
  if (!job) return;
  const result = job.result;
  const href = `${result.download}?t=${encodeURIComponent(TOKEN)}`;
  $("#backup-result").innerHTML = `<p>${esc(result.file_count)} files, ${esc(result.size_mb)} MB — <a href="${esc(href)}" download>Download ${esc(result.zip_name)}</a></p>`;
  toast("Backup ready");
}

// ---- wiring ---------------------------------------------------------------------------------------

function switchTab(name) {
  $$(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === name));
  $$(".tab-panel").forEach((panel) => (panel.hidden = panel.dataset.panel !== name));
}

function wire() {
  $$("#connect-form input[name=protocol]").forEach((radio) => radio.addEventListener("change", syncProtocolFields));
  $("#connect-form").addEventListener("submit", (event) => {
    event.preventDefault();
    connect();
  });

  $("#profile-select").addEventListener("change", () => {
    const profile = (state.snapshot.profiles || []).find((p) => p.name === $("#profile-select").value);
    if (!profile) return;
    fillSettings(profile.settings);
    fillLayout($("#connect-form"), profile.layout);
    $("#connect-form").elements.profile_name.value = profile.name;
  });
  $("#profile-save").addEventListener("click", async () => {
    const name = $("#connect-form").elements.profile_name.value.trim() || formSettings().host || "Local";
    try {
      const { profiles } = await api("POST", "/api/profiles", { name, settings: formSettings(), layout: formLayout($("#connect-form")) });
      state.snapshot.profiles = profiles;
      renderProfiles(profiles);
      $("#profile-select").value = name;
      toast(`Saved profile "${name}" (without password)`);
    } catch (error) {
      toast(error.message, true);
    }
  });
  $("#profile-delete").addEventListener("click", async () => {
    const name = $("#profile-select").value;
    if (!name) return;
    const { profiles } = await api("DELETE", `/api/profiles?name=${encodeURIComponent(name)}`);
    state.snapshot.profiles = profiles;
    renderProfiles(profiles);
  });

  $("#disconnect-btn").addEventListener("click", async () => {
    try {
      await api("POST", "/api/disconnect", {});
      state.status = null;
      await refreshSnapshot();
    } catch (error) {
      toast(error.message, true);
    }
  });

  $("#world-select").addEventListener("change", (event) => {
    state.world = event.target.value;
    $("#plan").innerHTML = "";
    $("#backup-result").innerHTML = "";
    loadWorld();
  });
  $("#refresh-btn").addEventListener("click", async () => {
    try {
      const job = await runJob("/api/status", { world: state.world, refresh_worlds: true }, { quiet: true });
      state.status = job.result;
      await refreshSnapshot();
    } catch (error) {
      toast(error.message, true);
    }
  });
  $("#layout-btn").addEventListener("click", async () => {
    fillLayout($("#layout-form"), state.snapshot.overrides);
    if (!(await showDialog($("#layout-dialog")))) return;
    log("— Updating layout —");
    if (await simpleJob("/api/layout", { layout: formLayout($("#layout-form")) }, "Layout updated")) await refreshSnapshot();
  });

  $$(".tabs button").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));

  $("#pack-filter").addEventListener("input", renderPackRows);
  $("#status-filter").addEventListener("change", renderPackRows);
  $("#pack-rows").addEventListener("change", updateUninstallButton);
  $("#select-all").addEventListener("change", (event) => {
    $$(".pack-check").forEach((el) => (el.checked = event.target.checked));
    updateUninstallButton();
  });
  $("#uninstall-btn").addEventListener("click", uninstall);

  const dropzone = $("#dropzone");
  ["dragenter", "dragover"].forEach((type) =>
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach((type) => dropzone.addEventListener(type, () => dropzone.classList.remove("over")));
  dropzone.addEventListener("drop", async (event) => {
    event.preventDefault();
    const entries = Array.from(event.dataTransfer.items || [])
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (entries.length) {
      const nested = await Promise.all(entries.map((entry) => walkEntry(entry)));
      await uploadFiles(nested.flat());
    } else {
      await uploadFiles(Array.from(event.dataTransfer.files).map((file) => ({ file, path: file.name })));
    }
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
    const name = event.target.dataset.remove;
    if (!name) return;
    const { uploads } = await api("DELETE", `/api/uploads?name=${encodeURIComponent(name)}`);
    renderUploads(uploads);
    $("#plan").innerHTML = "";
  });
  $("#clear-uploads").addEventListener("click", async () => {
    const { uploads } = await api("DELETE", "/api/uploads");
    renderUploads(uploads);
    $("#plan").innerHTML = "";
  });
  $("#preview-btn").addEventListener("click", () => install(true));
  $("#install-btn").addEventListener("click", async () => {
    const ok = await confirmDialog("Install these packs?", `<p>Packs will be uploaded to <b>${esc(state.snapshot.label)}</b> and registered in this world.</p>`, "Install");
    if (ok) install(false);
  });

  $("#edit-btn").addEventListener("click", editWorld);
  $("#doctor-btn").addEventListener("click", async () => {
    log("— Auditing —");
    const job = await simpleJob("/api/doctor", { world: state.world });
    if (job) {
      state.status = job.result;
      renderStatus();
      toast(job.warnings.length ? `Audit found ${job.warnings.length} issue(s)` : "Audit clean", job.warnings.length > 0);
    }
  });
  $("#rebuild-btn").addEventListener("click", rebuild);
  $("#cleanup-btn").addEventListener("click", cleanup);
  $("#backup-world-btn").addEventListener("click", () => backup(true));
  $("#backup-all-btn").addEventListener("click", () => backup(false));
  $("#clear-log").addEventListener("click", () => ($("#log").textContent = ""));
}

async function init() {
  wire();
  syncProtocolFields();
  if (!TOKEN) {
    $("#connect-view").innerHTML = '<div class="notice error">Missing access token. Open the full link printed in the terminal.</div>';
    return;
  }
  try {
    await refreshSnapshot();
    if (!state.snapshot.connected && state.snapshot.settings) {
      fillSettings(state.snapshot.settings);
      if (state.snapshot.has_password) $("#connect-form").elements.password.placeholder = "Using the password from the command line";
    }
  } catch (error) {
    $("#connect-view").innerHTML = `<div class="notice error">${esc(error.message)}</div>`;
  }
}

document.addEventListener("DOMContentLoaded", init);
