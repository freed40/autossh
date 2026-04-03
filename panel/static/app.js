const rowsEl = document.getElementById("rows");
const msgEl = document.getElementById("msg");
const btnRefresh = document.getElementById("btn-refresh");
const formEl = document.getElementById("tunnel-form");
const formTitleEl = document.getElementById("form-title");
const btnSubmit = document.getElementById("btn-submit");
const btnFormReset = document.getElementById("btn-form-reset");
const fId = document.getElementById("f-id");

const DEFAULT_EXTRA_JSON = '["-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=60"]';

let editingId = null;

function showMsg(text, isError) {
  msgEl.hidden = !text;
  msgEl.textContent = text || "";
  msgEl.className = "msg" + (isError ? " error" : "");
}

async function fetchJSON(url, options) {
  const r = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options && options.headers),
    },
  });
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const j = await r.json();
      if (j.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail || "Anfrage fehlgeschlagen");
  }
  if (r.status === 204) return null;
  return r.json();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseExtraArgs() {
  const raw = document.getElementById("f-extra_ssh_args").value.trim();
  if (!raw) return [];
  let extra;
  try {
    extra = JSON.parse(raw);
  } catch {
    throw new Error("Zusätzliche SSH-Argumente: kein gültiges JSON");
  }
  if (!Array.isArray(extra) || !extra.every((x) => typeof x === "string")) {
    throw new Error("extra_ssh_args muss ein JSON-Array aus Strings sein");
  }
  return extra;
}

function formToPayload() {
  const identity = document.getElementById("f-identity_file").value.trim();
  return {
    id: fId.value.trim(),
    name: document.getElementById("f-name").value.trim(),
    enabled: document.getElementById("f-enabled").checked,
    ssh_user: document.getElementById("f-ssh_user").value.trim(),
    ssh_host: document.getElementById("f-ssh_host").value.trim(),
    ssh_port: Number(document.getElementById("f-ssh_port").value),
    identity_file: identity || null,
    monitor_port: Number(document.getElementById("f-monitor_port").value),
    remote_forward: document.getElementById("f-remote_forward").value.trim(),
    extra_ssh_args: parseExtraArgs(),
  };
}

function setFormDefaults() {
  document.getElementById("f-ssh_port").value = "22";
  document.getElementById("f-monitor_port").value = "20000";
  document.getElementById("f-extra_ssh_args").value = DEFAULT_EXTRA_JSON;
}

function exitEditMode() {
  editingId = null;
  fId.disabled = false;
  formTitleEl.textContent = "Tunnel anlegen";
  btnSubmit.textContent = "Tunnel anlegen";
  btnFormReset.hidden = true;
  formEl.reset();
  setFormDefaults();
}

async function startEdit(id) {
  showMsg("");
  try {
    const t = await fetchJSON(`/api/tunnels/${encodeURIComponent(id)}`);
    editingId = id;
    fId.value = t.id;
    fId.disabled = true;
    document.getElementById("f-name").value = t.name || "";
    document.getElementById("f-ssh_user").value = t.ssh_user;
    document.getElementById("f-ssh_host").value = t.ssh_host;
    document.getElementById("f-ssh_port").value = String(t.ssh_port);
    document.getElementById("f-identity_file").value = t.identity_file || "";
    document.getElementById("f-monitor_port").value = String(t.monitor_port);
    document.getElementById("f-remote_forward").value = t.remote_forward;
    document.getElementById("f-enabled").checked = !!t.enabled;
    document.getElementById("f-extra_ssh_args").value = JSON.stringify(t.extra_ssh_args || [], null, 2);
    formTitleEl.textContent = "Tunnel bearbeiten";
    btnSubmit.textContent = "Änderungen speichern";
    btnFormReset.hidden = false;
    formTitleEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    showMsg(e.message, true);
  }
}

async function deleteTunnel(id) {
  if (!confirm(`Tunnel „${id}“ wirklich löschen?`)) return;
  showMsg("");
  try {
    await fetchJSON(`/api/tunnels/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (editingId === id) exitEditMode();
    await loadTunnels();
  } catch (e) {
    showMsg(e.message, true);
  }
}

function renderRow(t) {
  const tr = document.createElement("tr");
  const enabledClass = t.enabled ? "on" : "off";
  const enabledLabel = t.enabled ? "Ja" : "Nein";
  const runClass = t.running ? "run" : "stop";
  const runLabel = t.running ? `Läuft (${t.pid})` : "Gestoppt";

  tr.innerHTML = `
    <td>${escapeHtml(t.name)}</td>
    <td><code>${escapeHtml(t.id)}</code></td>
    <td><span class="badge ${enabledClass}">${enabledLabel}</span></td>
    <td><span class="badge ${runClass}">${escapeHtml(runLabel)}</span></td>
    <td class="actions">
      <button type="button" class="btn sm ${t.enabled ? "danger" : ""}" data-act="toggle" data-id="${escapeHtml(
    t.id
  )}" data-next="${t.enabled ? "0" : "1"}">
        ${t.enabled ? "Deaktivieren" : "Aktivieren"}
      </button>
      <button type="button" class="btn secondary sm" data-act="edit" data-id="${escapeHtml(t.id)}">Bearbeiten</button>
      <button type="button" class="btn danger sm" data-act="del" data-id="${escapeHtml(t.id)}">Löschen</button>
    </td>
  `;
  return tr;
}

async function loadTunnels() {
  showMsg("");
  btnRefresh.disabled = true;
  try {
    const list = await fetchJSON("/api/tunnels");
    rowsEl.innerHTML = "";
    for (const t of list) {
      rowsEl.appendChild(renderRow(t));
    }
    rowsEl.querySelectorAll("button[data-act]").forEach((btn) => {
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if (act === "toggle") {
        btn.addEventListener("click", () => onToggle(id, btn.dataset.next === "1"));
      } else if (act === "edit") {
        btn.addEventListener("click", () => startEdit(id));
      } else if (act === "del") {
        btn.addEventListener("click", () => deleteTunnel(id));
      }
    });
  } catch (e) {
    showMsg(e.message, true);
  } finally {
    btnRefresh.disabled = false;
  }
}

async function onToggle(id, enable) {
  showMsg("");
  try {
    await fetchJSON(`/api/tunnels/${encodeURIComponent(id)}/enabled`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: enable }),
    });
    await loadTunnels();
  } catch (e) {
    showMsg(e.message, true);
  }
}

formEl.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showMsg("");
  let payload;
  try {
    payload = formToPayload();
  } catch (e) {
    showMsg(e.message, true);
    return;
  }
  try {
    if (editingId) {
      payload.id = editingId;
      await fetchJSON(`/api/tunnels/${encodeURIComponent(editingId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await fetchJSON("/api/tunnels", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    exitEditMode();
    await loadTunnels();
  } catch (e) {
    showMsg(e.message, true);
  }
});

btnFormReset.addEventListener("click", () => exitEditMode());

btnRefresh.addEventListener("click", loadTunnels);

setFormDefaults();
loadTunnels();
