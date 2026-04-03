/**
 * SSH tunnel dashboard API (Express).
 * Runs autossh via child_process.spawn (argument list only — no shell).
 *
 * Note: We intentionally omit autossh's -f so the child stays attached and we
 * can reliably track/kill the process. Equivalent to: autossh -M 0 -N -L ...
 */

import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const TUNNELS_PATH = path.join(DATA_DIR, "tunnels.json");

const PORT = Number(process.env.PORT) || 3456;
const LOG_MAX_LINES = 500;

/** @typedef {{ id: string, name: string, localPort: number, remotePort: number, sshUser: string, sshHost: string, sshPort: number }} TunnelConfig */

/** @type {Map<string, { process: import('node:child_process').ChildProcess, logs: string[] }>} */
const running = new Map();

function assertPort(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${field} muss eine Ganzzahl zwischen 1 und 65535 sein`);
  }
  return n;
}

function assertSshUser(user) {
  if (typeof user !== "string" || !/^[a-zA-Z0-9._-]+$/.test(user)) {
    throw new Error("sshUser: nur Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich");
  }
}

function assertSshHost(host) {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) {
    throw new Error("sshHost ungültig");
  }
  // Hostname, Punkt-Labels, IPv4 oder geklammerte IPv6
  const ok =
    /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
      host
    ) ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    /^\[[0-9a-fA-F:.]+\]$/.test(host);
  if (!ok) {
    throw new Error("sshHost: ungültiger Hostname oder IP");
  }
}

function assertId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    throw new Error("id: nur Buchstaben, Ziffern, Unterstrich, Bindestrich; mit Buchstabe/Ziffer beginnen");
  }
}

/** @param {unknown} raw */
function normalizeTunnel(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Tunnel-Eintrag fehlt");
  const t = /** @type {Record<string, unknown>} */ (raw);
  assertId(String(t.id));
  const name = typeof t.name === "string" ? t.name : String(t.id);
  const localPort = assertPort(t.localPort, "localPort");
  const remotePort = assertPort(t.remotePort, "remotePort");
  const sshPort = t.sshPort === undefined || t.sshPort === null ? 2222 : assertPort(t.sshPort, "sshPort");
  assertSshUser(String(t.sshUser));
  assertSshHost(String(t.sshHost));
  return {
    id: String(t.id),
    name,
    localPort,
    remotePort,
    sshUser: String(t.sshUser),
    sshHost: String(t.sshHost),
    sshPort,
  };
}

async function loadTunnelConfigs() {
  try {
    const raw = await fs.readFile(TUNNELS_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.tunnels)) {
      throw new Error("tunnels.json: \"tunnels\" muss ein Array sein");
    }
    return data.tunnels.map(normalizeTunnel);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") {
      throw new Error(
        `Datei fehlt: ${TUNNELS_PATH}. Kopiere data/tunnels.example.json nach data/tunnels.json.`
      );
    }
    throw e;
  }
}

async function getTunnelById(id) {
  const list = await loadTunnelConfigs();
  return list.find((t) => t.id === id) ?? null;
}

function pushLog(id, line) {
  const entry = running.get(id);
  if (!entry) return;
  const ts = new Date().toISOString();
  entry.logs.push(`[${ts}] ${line}`);
  if (entry.logs.length > LOG_MAX_LINES) {
    entry.logs.splice(0, entry.logs.length - LOG_MAX_LINES);
  }
}

/**
 * @param {TunnelConfig} cfg
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnAutossh(cfg) {
  const forward = `${cfg.localPort}:localhost:${cfg.remotePort}`;
  const args = [
    "-M",
    "0",
    "-N",
    "-L",
    forward,
    "-p",
    String(cfg.sshPort),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    `${cfg.sshUser}@${cfg.sshHost}`,
  ];
  const child = spawn("autossh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    shell: false,
    env: { ...process.env },
  });
  return child;
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/tunnels", async (_req, res) => {
  try {
    const configs = await loadTunnelConfigs();
    const payload = configs.map((c) => {
      const run = running.get(c.id);
      const proc = run?.process;
      const alive = proc && proc.exitCode === null && proc.signalCode === null;
      return {
        ...c,
        status: alive ? "active" : "inactive",
        pid: alive ? proc.pid : null,
        logLineCount: run ? run.logs.length : 0,
      };
    });
    res.json({ tunnels: payload });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

app.get("/api/tunnels/:id/logs", async (req, res) => {
  try {
    assertId(req.params.id);
    const cfg = await getTunnelById(req.params.id);
    if (!cfg) {
      res.status(404).json({ error: "Tunnel unbekannt" });
      return;
    }
    const run = running.get(cfg.id);
    res.json({ logs: run ? [...run.logs] : [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

app.post("/api/tunnels/:id/start", async (req, res) => {
  try {
    assertId(req.params.id);
    const cfg = await getTunnelById(req.params.id);
    if (!cfg) {
      res.status(404).json({ error: "Tunnel unbekannt" });
      return;
    }
    const existing = running.get(cfg.id);
    if (existing?.process && existing.process.exitCode === null && existing.process.signalCode === null) {
      res.status(409).json({ error: "Tunnel läuft bereits", pid: existing.process.pid });
      return;
    }
    if (existing) running.delete(cfg.id);

    const logs = [];
    running.set(cfg.id, { process: /** @type {import('node:child_process').ChildProcess} */ (null), logs });
    const entry = running.get(cfg.id);
    entry.logs.push(`[${new Date().toISOString()}] Befehl: autossh ${["-M", "0", "-N", "-L", `${cfg.localPort}:localhost:${cfg.remotePort}`, "-p", String(cfg.sshPort), "-o", "ExitOnForwardFailure=yes", "-o", "BatchMode=yes", `${cfg.sshUser}@${cfg.sshHost}`].join(" ")}`);

    const child = spawnAutossh(cfg);
    entry.process = child;

    child.stdout?.on("data", (chunk) => {
      pushLog(cfg.id, String(chunk).trimEnd());
    });
    child.stderr?.on("data", (chunk) => {
      pushLog(cfg.id, String(chunk).trimEnd());
    });
    child.on("error", (err) => {
      pushLog(cfg.id, `Prozessfehler: ${err.message}`);
    });
    child.on("exit", (code, signal) => {
      pushLog(cfg.id, `Beendet (code=${code}, signal=${signal ?? "none"})`);
      const cur = running.get(cfg.id);
      if (cur?.process === child) {
        running.delete(cfg.id);
      }
    });

    res.status(201).json({ ok: true, pid: child.pid, status: "active" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

app.post("/api/tunnels/:id/stop", async (req, res) => {
  try {
    assertId(req.params.id);
    const cfg = await getTunnelById(req.params.id);
    if (!cfg) {
      res.status(404).json({ error: "Tunnel unbekannt" });
      return;
    }
    const entry = running.get(cfg.id);
    if (!entry?.process) {
      res.json({ ok: true, status: "inactive", message: "War nicht aktiv" });
      return;
    }
    const proc = entry.process;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      running.delete(cfg.id);
      res.json({ ok: true, status: "inactive" });
      return;
    }
    pushLog(cfg.id, "Stop angefordert (SIGTERM)");
    proc.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        pushLog(cfg.id, "SIGKILL nach Timeout");
        proc.kill("SIGKILL");
      }
    }, 5000);
    killTimer.unref?.();

    res.json({ ok: true, status: "stopping", pid: proc.pid });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Interner Serverfehler" });
});

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

await ensureDataDir();

app.listen(PORT, () => {
  console.log(`Tunnel-Dashboard API: http://127.0.0.1:${PORT}`);
  console.log(`Config: ${TUNNELS_PATH}`);
});
