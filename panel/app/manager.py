from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from pathlib import Path

from .models import ConfigFile, Tunnel, TunnelStatus

log = logging.getLogger(__name__)


class TunnelManager:
    def __init__(self, config_path: Path) -> None:
        self._config_path = config_path
        self._lock = threading.RLock()
        self._procs: dict[str, subprocess.Popen[bytes]] = {}

    def _ensure_parent(self) -> None:
        self._config_path.parent.mkdir(parents=True, exist_ok=True)

    def load(self) -> ConfigFile:
        with self._lock:
            if not self._config_path.is_file():
                self._ensure_parent()
                cfg = ConfigFile()
                self._atomic_write(cfg)
                return cfg
            raw = self._config_path.read_text(encoding="utf-8")
            return ConfigFile.model_validate_json(raw)

    def _atomic_write(self, cfg: ConfigFile) -> None:
        self._ensure_parent()
        tmp = self._config_path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(cfg.model_dump(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, self._config_path)

    def save(self, cfg: ConfigFile) -> None:
        with self._lock:
            self._atomic_write(cfg)

    def list_status(self) -> list[TunnelStatus]:
        with self._lock:
            cfg = self.load()
            out: list[TunnelStatus] = []
            for t in cfg.tunnels:
                p = self._procs.get(t.id)
                running = p is not None and p.poll() is None
                pid = p.pid if running else None
                out.append(
                    TunnelStatus(
                        id=t.id,
                        name=t.name or t.id,
                        enabled=t.enabled,
                        running=running,
                        pid=pid,
                    )
                )
            return out

    def get_tunnel(self, tunnel_id: str) -> Tunnel | None:
        cfg = self.load()
        for t in cfg.tunnels:
            if t.id == tunnel_id:
                return t
        return None

    def add_tunnel(self, tunnel: Tunnel) -> Tunnel:
        with self._lock:
            cfg = self.load()
            if any(t.id == tunnel.id for t in cfg.tunnels):
                raise ValueError(f"Tunnel-ID bereits vergeben: {tunnel.id}")
            cfg.tunnels.append(tunnel)
            self._atomic_write(cfg)
            if tunnel.enabled:
                self._start_unlocked(tunnel)
            return tunnel

    def delete_tunnel(self, tunnel_id: str) -> bool:
        with self._lock:
            cfg = self.load()
            before = len(cfg.tunnels)
            cfg.tunnels = [t for t in cfg.tunnels if t.id != tunnel_id]
            if len(cfg.tunnels) == before:
                return False
            self._stop_unlocked(tunnel_id)
            self._atomic_write(cfg)
            return True

    def replace_tunnel(self, tunnel_id: str, tunnel: Tunnel) -> Tunnel | None:
        if tunnel.id != tunnel_id:
            raise ValueError("Tunnel-ID im Pfad und im JSON müssen übereinstimmen")
        with self._lock:
            cfg = self.load()
            idx = next((i for i, t in enumerate(cfg.tunnels) if t.id == tunnel_id), None)
            if idx is None:
                return None
            self._stop_unlocked(tunnel_id)
            cfg.tunnels[idx] = tunnel
            self._atomic_write(cfg)
            if tunnel.enabled:
                self._start_unlocked(tunnel)
            return tunnel

    def set_enabled(self, tunnel_id: str, enabled: bool) -> Tunnel | None:
        with self._lock:
            cfg = self.load()
            found: Tunnel | None = None
            for i, t in enumerate(cfg.tunnels):
                if t.id == tunnel_id:
                    found = t.model_copy(update={"enabled": enabled})
                    cfg.tunnels[i] = found
                    break
            if found is None:
                return None
            self._atomic_write(cfg)
            if enabled:
                self._start_unlocked(found)
            else:
                self._stop_unlocked(tunnel_id)
            return found

    def _build_cmd(self, t: Tunnel) -> list[str]:
        cmd: list[str] = [
            "autossh",
            "-M",
            str(t.monitor_port),
            "-N",
            "-p",
            str(t.ssh_port),
            "-o",
            "BatchMode=yes",
            "-o",
            "ExitOnForwardFailure=yes",
        ]
        if t.identity_file:
            cmd.extend(["-i", t.identity_file])
        cmd.extend(t.extra_ssh_args)
        cmd.extend(["-R", t.remote_forward])
        cmd.append(f"{t.ssh_user}@{t.ssh_host}")
        return cmd

    def _start_unlocked(self, t: Tunnel) -> None:
        self._stop_unlocked(t.id)
        if not t.enabled:
            return
        cmd = self._build_cmd(t)
        log.info("Starte Tunnel %s: %s", t.id, " ".join(cmd))
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        self._procs[t.id] = proc

    def _stop_unlocked(self, tunnel_id: str) -> None:
        proc = self._procs.pop(tunnel_id, None)
        if proc is None:
            return
        if proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()

    def stop_all(self) -> None:
        with self._lock:
            for tid in list(self._procs.keys()):
                self._stop_unlocked(tid)

    def reconcile(self) -> None:
        with self._lock:
            cfg = self.load()
            wanted = {t.id for t in cfg.tunnels if t.enabled}
            for tid in list(self._procs.keys()):
                if tid not in wanted:
                    self._stop_unlocked(tid)
            by_id = {t.id: t for t in cfg.tunnels}
            for tid in wanted:
                t = by_id.get(tid)
                if t is None:
                    continue
                p = self._procs.get(tid)
                if p is None or p.poll() is not None:
                    self._start_unlocked(t)
