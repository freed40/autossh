# autossh (dieses Repository)

Die **originale Programmdokumentation** zu autossh (Build, Optionen,
Umgebungsvariablen usw.) steht in **[README](README)** und ist auf **Englisch**.

Diese Datei fasst nur die **optionalen Zusätze** in diesem Repository auf
**Deutsch** zusammen: das Python-**Panel**, Docker Compose, CI und das
Node-**Dashboard**.

---

## Web-Steuerpanel (optional)

Neben dem C-Programm gibt es zwei optionale Helfer:

- **`panel/`** — **Python / FastAPI**-Panel (vor allem **Remote-**`-R`-Tunnels),
  Docker Compose, Anbindung an **Uptime Kuma**.
- **`dashboard/`** — **Node / Express**-API für **lokale** `-L`-Weiterleitungen
  vom Laptop zum Heimserver (siehe unten).

Die **FastAPI**-Anwendung unter `panel/` startet `autossh` als Kindprozesse;
Konfiguration als JSON. Es gibt eine Web-Oberfläche und HTTP-Endpunkte zum
Ein-/Ausschalten, Anlegen und Bearbeiten von Tunneln sowie Health-Checks für
Uptime Kuma.

### Docker Compose

Im Repository-Root:

```bash
cp data/connections.example.json data/connections.json
# data/connections.json anpassen (Benutzer, Host, -R-Ziel, Identity-Pfad).

docker compose up -d --build
```

- **Panel (UI + API):** http://localhost:8080  
- **Uptime Kuma** (optional in Compose): http://localhost:3001  

SSH-Keys nur lesend einbinden, z. B. `${HOME}/.ssh:/root/.ssh:ro`; bei strenger
Host-Key-Prüfung `known_hosts` befüllen.

Umgebungsvariable (optional): `AUTOSHH_PANEL_CONFIG_PATH` (Standard im
Container: `/data/connections.json`, in Compose aus `./data` gemountet).

### Konfiguration (`data/connections.json`)

Pro Tunnel u. a.: `id`, `ssh_user`, `ssh_host`, `ssh_port`, `monitor_port`
(autossh `-M`), `remote_forward` (ein Argument für `ssh -R`), optional
`identity_file`, `extra_ssh_args` (Liste von Strings).

**Ein Port, viele interne Dienste:** dynamischer Remote-Forward (SOCKS auf dem
SSH-Server), z. B. `remote_forward` `*:1080`. Auf dem Server `GatewayPorts` in
`sshd_config` setzen. Läuft das Panel im Docker **auf dem Laptop** und soll
ins LAN, unter Linux `network_mode: host` für den Dienst `panel` und keine
`ports:`-Veröffentlichung (siehe Kommentare in `docker-compose.yml`).

### HTTP-API (Kurzüberblick)

- `GET /api/tunnels` — Statusliste  
- `GET /api/tunnels/{id}` — ein Tunnel  
- `POST /api/tunnels` — anlegen  
- `PUT /api/tunnels/{id}` — ersetzen  
- `DELETE /api/tunnels/{id}` — löschen  
- `PATCH /api/tunnels/{id}/enabled` — `{"enabled": true|false}`  
- `GET` / `PUT /api/config` — gesamte Konfiguration  

### Überwachung (Uptime Kuma)

- `GET /monitor/stack` — `200` mit Text `ok`, wenn alle **aktivierten** Tunnel
  laufen; sonst `503` / `unhealthy`.  
- `GET /monitor/tunnel/{id}` — `ok` / `disabled` / `503` pro Tunnel.  

Im Compose-Netzwerk z. B. `http://panel:8080/monitor/stack`.

### Continuous Integration

Workflow `.github/workflows/ci.yml`: Docker-Image bauen, Python-Panel prüfen
(Dependencies, `compileall`, Import der FastAPI-App), C-Quelltext mit
`./configure` und `make`.

### Panel lokal (ohne Docker)

```bash
python3 -m venv .venv
.venv/bin/pip install -r panel/requirements.txt
export AUTOSHH_PANEL_CONFIG_PATH=$PWD/data/connections.json
PYTHONPATH=. .venv/bin/uvicorn panel.app.main:app --reload --port 8080
```

Zum Aktivieren von Tunneln müssen `autossh` und `ssh` auf dem Host verfügbar
sein.

---

## Lokales Tunnel-Dashboard (optional, Node.js)

Das Verzeichnis **`dashboard/`** enthält eine kleine **Express**-API für
**lokale** Portweiterleitungen (`-L localPort:localhost:remotePort`) von deinem
Rechner (z. B. MacBook) zum Heimserver — sinnvoll bei **nicht standardisiertem
SSH-Port** und mehreren benannten Tunneln.

### Einrichtung

```bash
cd dashboard
cp data/tunnels.example.json data/tunnels.json
# tunnels.json bearbeiten — pro Tunnel: id, name, localPort, remotePort,
# sshUser, sshHost, sshPort (Standard 2222).

npm install
npm start
```

Standard-API: **http://127.0.0.1:3456** (Port über Umgebungsvariable `PORT`).
Benötigt **Node.js 18+** und `autossh` im `PATH`.

### Verhalten und Sicherheit

Der Server startet `autossh` mit **`child_process.spawn`** und **nur**
Argument-Array (`shell: false`), damit keine Shell eingeschaltet wird und das
Risiko von Injection sinkt. Eingaben werden geprüft (Ports, Benutzername,
Host).

Für zuverlässiges **Starten/Stoppen und PID-Tracking** wird **kein** autossh
**`-f`** verwendet (Vordergrund-Prozess). OpenSSH-Optionen u. a.
`ExitOnForwardFailure=yes` und `BatchMode=yes` (Schlüssel-Auth; kein
Passwort-Prompt in der UI).

### HTTP-API (Kurzüberblick)

- `GET /api/health` — Liveness  
- `GET /api/tunnels` — Liste inkl. `status` (`active` / `inactive`), `pid`,
  Log-Umfang  
- `GET /api/tunnels/:id/logs` — letzte stdout/stderr-Zeilen  
- `POST /api/tunnels/:id/start` — Tunnel starten  
- `POST /api/tunnels/:id/stop` — Tunnel stoppen (SIGTERM, ggf. SIGKILL)  

CORS ist für lokale Frontend-Entwicklung aktiv. Ein **React + Tailwind**-UI
kann z. B. mit Vite unter `dashboard/` ergänzt werden und diese API ansprechen.

---

*Upstream-Hinweis: „Kudos and raspberries to harding [at] motd.ca“ — siehe
englische [README](README).*
