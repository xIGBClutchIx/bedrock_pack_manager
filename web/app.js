// Browser front end for Bedrock Pack Manager.
// The real work is done by the same Python package the CLI uses, running in Pyodide.

const BASE_DIR = "/home/pyodide/session";
const RUN_DIR = `${BASE_DIR}/run`;
const LIB_DIR = "/home/pyodide/lib";

const $ = (id) => document.getElementById(id);

let pyodide = null;
let web = null;
let nativeFs = null;
let sourceMode = null; // "folder" or "zip"
let pendingPacks = [];
let busy = false;

// ---------- output ----------

const ANSI_RE = /\x1b\[([0-9;]*)m/g;

function ansiToHtml(text) {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = "";
  let open = 0;
  let last = 0;
  for (const match of text.matchAll(ANSI_RE)) {
    html += escape(text.slice(last, match.index));
    last = match.index + match[0].length;
    for (const code of match[1].split(";")) {
      if (code === "0" || code === "") {
        html += "</span>".repeat(open);
        open = 0;
      } else {
        html += `<span class="ansi-${code}">`;
        open += 1;
      }
    }
  }
  html += escape(text.slice(last)) + "</span>".repeat(open);
  return html;
}

function appendOutput(line) {
  $("output-card").hidden = false;
  const out = $("output");
  out.insertAdjacentHTML("beforeend", ansiToHtml(line) + "\n");
  out.scrollTop = out.scrollHeight;
}

function setStatus(id, message, isError = false) {
  const el = $(id);
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll("button")) {
    button.disabled = value;
  }
}

// ---------- python ----------

async function loadApp() {
  pyodide = await loadPyodide();
  pyodide.setStdout({ batched: appendOutput });
  pyodide.setStderr({ batched: appendOutput });
  await pyodide.loadPackage("micropip");
  await pyodide.pyimport("micropip").install("nbtlib");

  const response = await fetch("bedrock_pack_manager.zip");
  pyodide.FS.mkdirTree(LIB_DIR);
  pyodide.unpackArchive(await response.arrayBuffer(), "zip", { extractDir: LIB_DIR });
  pyodide.FS.mkdirTree(BASE_DIR);
  pyodide.runPython(`
import os, sys
sys.path.insert(0, "${LIB_DIR}")
os.chdir("${BASE_DIR}")
`);
  web = pyodide.pyimport("bedrock_pack_manager.web");
}

async function syncToDisk() {
  if (nativeFs) {
    await nativeFs.syncfs();
  }
}

function resetRunDir() {
  if (nativeFs) {
    pyodide.FS.unmount(RUN_DIR);
    nativeFs = null;
  }
  pyodide.runPython(`
import shutil
shutil.rmtree("${RUN_DIR}", ignore_errors=True)
`);
}

// ---------- step 1: source ----------

async function openFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite", id: "bedrock-server" });
  } catch (err) {
    if (err.name !== "AbortError") setStatus("source-status", err.message, true);
    return;
  }
  setBusy(true);
  try {
    setStatus("source-status", "Reading folder…");
    resetRunDir();
    pyodide.FS.mkdirTree(RUN_DIR);
    nativeFs = await pyodide.mountNativeFS(RUN_DIR, handle);
    sourceMode = "folder";
    $("step-save").hidden = true;
    await refreshWorlds(`Using folder "${handle.name}". Changes are saved straight to it.`);
    await syncToDisk();
  } catch (err) {
    setStatus("source-status", `Could not open that folder: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function uploadZip(file) {
  setBusy(true);
  try {
    setStatus("source-status", "Unpacking zip…");
    resetRunDir();
    pyodide.FS.mkdirTree(RUN_DIR);
    pyodide.unpackArchive(await file.arrayBuffer(), "zip", { extractDir: RUN_DIR });
    const result = JSON.parse(web.normalize_upload(RUN_DIR));
    if (!result.ok) {
      setStatus("source-status", result.error, true);
      return;
    }
    sourceMode = "zip";
    $("step-save").hidden = false;
    await refreshWorlds(`Using "${file.name}".`);
  } catch (err) {
    setStatus("source-status", `Could not read that zip: ${err.message}`, true);
  } finally {
    setBusy(false);
  }
}

// ---------- step 2: world ----------

async function refreshWorlds(statusMessage) {
  const worlds = JSON.parse(web.list_worlds(BASE_DIR));
  const select = $("world-select");
  const previous = select.value;
  select.replaceChildren(...worlds.map((name) => new Option(name, name)));
  if (worlds.includes(previous)) select.value = previous;

  if (!worlds.length) {
    setStatus("source-status", "No worlds found. The folder needs a worlds folder with at least one world inside.", true);
    $("step-world").hidden = true;
    $("step-actions").hidden = true;
    return;
  }
  setStatus("source-status", statusMessage);
  $("step-world").hidden = false;
  $("step-actions").hidden = false;
  refreshUninstallList();
}

function refreshUninstallList() {
  const list = $("uninstall-list");
  const world = $("world-select").value;
  if (!world) return;
  const candidates = JSON.parse(web.uninstall_candidates(BASE_DIR, world));
  if (!candidates.length) {
    list.innerHTML = '<p class="hint">No packs are registered in this world.</p>';
    return;
  }
  list.replaceChildren(
    ...candidates.map((candidate) => {
      const label = document.createElement("label");
      label.className = "check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = candidate.flag;
      const text = document.createElement("span");
      text.textContent = candidate.label;
      const details = document.createElement("small");
      details.textContent = candidate.details;
      text.append(details);
      label.append(box, text);
      return label;
    }),
  );
}

// ---------- step 3: actions ----------

async function runAction(flags, { duplicateMode = "replace" } = {}) {
  if (busy) return null;
  setBusy(true);
  try {
    const result = JSON.parse(web.run_action(BASE_DIR, $("world-select").value, JSON.stringify(flags), duplicateMode));
    if (result.zip_path) downloadFile(result.zip_path);
    await syncToDisk();
    refreshUninstallList();
    return result;
  } catch (err) {
    appendOutput(`\x1b[91mSomething went wrong: ${err.message}\x1b[0m`);
    return null;
  } finally {
    setBusy(false);
  }
}

function downloadFile(path) {
  const data = pyodide.FS.readFile(path);
  const name = path.split("/").pop();
  const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  pyodide.FS.unlink(path);
}

function addPacks(files) {
  for (const file of files) {
    if (/\.(mcaddon|mcpack|zip)$/i.test(file.name)) pendingPacks.push(file);
  }
  $("pack-list").replaceChildren(
    ...pendingPacks.map((file) => {
      const item = document.createElement("li");
      item.textContent = file.name;
      return item;
    }),
  );
}

async function installPacks() {
  const installDir = `${RUN_DIR}/install`;
  pyodide.FS.mkdirTree(installDir);
  for (const file of pendingPacks) {
    pyodide.FS.writeFile(`${installDir}/${file.name}`, new Uint8Array(await file.arrayBuffer()));
  }
  pendingPacks = [];
  $("pack-list").replaceChildren();
  await runAction([], { duplicateMode: $("duplicate-mode").value });
}

async function editWorld() {
  const flags = [];
  if ($("edit-beta").checked) flags.push("--beta");
  if ($("edit-gamemode").value) flags.push(`--gamemode=${$("edit-gamemode").value}`);
  if (!flags.length) {
    appendOutput("\x1b[93mPick at least one world edit first.\x1b[0m");
    return;
  }
  await runAction(flags);
}

async function uninstallPacks() {
  const selected = [...document.querySelectorAll("#uninstall-list input:checked")].map((box) => box.value);
  if (!selected.length) {
    appendOutput("\x1b[93mTick at least one pack to uninstall.\x1b[0m");
    return;
  }
  const flags = ["--uninstall", ...selected];
  if ($("uninstall-keep-files").checked) flags.push("--uninstall-keep-files");
  await runAction(flags);
}

function confirmAndRun(message, flags) {
  if (window.confirm(message)) runAction(flags);
}

function zipFlags(name) {
  return name ? ["--zip", `--zip-name=${name}`] : ["--zip"];
}

// ---------- wiring ----------

function wireUp() {
  if ("showDirectoryPicker" in window) {
    $("folder-hint").textContent = "Your changes are saved directly into the folder you pick.";
  } else {
    $("open-folder").hidden = true;
    $("folder-hint").textContent =
      "Opening a folder needs Chrome or Edge on a computer. In this browser, zip the folder, upload it, and download the result when you're done.";
  }

  $("open-folder").addEventListener("click", openFolder);
  $("upload-zip").addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) uploadZip(file);
    event.target.value = "";
  });
  $("world-select").addEventListener("change", refreshUninstallList);

  const dropZone = $("drop-zone");
  $("pack-files").addEventListener("change", (event) => {
    addPacks(event.target.files);
    event.target.value = "";
  });
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
    addPacks(event.dataTransfer.files);
  });

  $("run-install").addEventListener("click", installPacks);
  $("run-edit").addEventListener("click", editWorld);
  $("run-uninstall").addEventListener("click", uninstallPacks);
  $("run-doctor").addEventListener("click", () => runAction(["--doctor"]));
  $("run-rebuild").addEventListener("click", () =>
    confirmAndRun("Rebuild overwrites this world's pack JSON files from the installed pack folders. Continue?", ["--rebuild"]),
  );
  $("run-cleanup").addEventListener("click", () =>
    confirmAndRun("Cleanup deletes pack folders that this world doesn't use. Continue?", ["--cleanup-pack-folders"]),
  );
  $("run-zip").addEventListener("click", () => runAction(zipFlags($("zip-name").value.trim())));
  $("download-folder").addEventListener("click", () => runAction(zipFlags("Bedrock_Server_Updated.zip")));
  $("clear-output").addEventListener("click", () => $("output").replaceChildren());
}

wireUp();
loadApp()
  .then(() => {
    $("loading").hidden = true;
    $("step-source").hidden = false;
  })
  .catch((err) => {
    setStatus("loading", `The pack manager failed to load: ${err.message}. Check your internet connection and refresh.`, true);
  });
