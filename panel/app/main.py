from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from starlette.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

from .manager import TunnelManager
from .models import ConfigFile, Tunnel, TunnelStatus

log = logging.getLogger(__name__)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AUTOSHH_PANEL_")

    config_path: Path = Path("/data/connections.json")
    static_dir: Path = Path(__file__).resolve().parent.parent / "static"


settings = Settings()
manager = TunnelManager(settings.config_path)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logging.basicConfig(level=logging.INFO)
    manager.reconcile()
    yield
    manager.stop_all()


app = FastAPI(title="Autossh-Steuerpanel", lifespan=lifespan)


class EnabledBody(BaseModel):
    enabled: bool


@app.get("/api/tunnels", response_model=list[TunnelStatus])
def api_list_tunnels() -> list[TunnelStatus]:
    manager.reconcile()
    return manager.list_status()


@app.get("/api/tunnels/{tunnel_id}", response_model=Tunnel)
def api_get_tunnel(tunnel_id: str) -> Tunnel:
    t = manager.get_tunnel(tunnel_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Tunnel unbekannt")
    return t


@app.post("/api/tunnels", response_model=Tunnel, status_code=201)
def api_create_tunnel(body: Tunnel) -> Tunnel:
    try:
        created = manager.add_tunnel(body)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    manager.reconcile()
    return created


@app.put("/api/tunnels/{tunnel_id}", response_model=Tunnel)
def api_replace_tunnel(tunnel_id: str, body: Tunnel) -> Tunnel:
    try:
        updated = manager.replace_tunnel(tunnel_id, body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if updated is None:
        raise HTTPException(status_code=404, detail="Tunnel unbekannt")
    manager.reconcile()
    return updated


@app.delete("/api/tunnels/{tunnel_id}")
def api_delete_tunnel(tunnel_id: str) -> Response:
    if not manager.delete_tunnel(tunnel_id):
        raise HTTPException(status_code=404, detail="Tunnel unbekannt")
    manager.reconcile()
    return Response(status_code=204)


@app.patch("/api/tunnels/{tunnel_id}/enabled", response_model=TunnelStatus)
def api_set_enabled(tunnel_id: str, body: EnabledBody) -> TunnelStatus:
    updated = manager.set_enabled(tunnel_id, body.enabled)
    if updated is None:
        raise HTTPException(status_code=404, detail="Tunnel unbekannt")
    manager.reconcile()
    st = next((s for s in manager.list_status() if s.id == tunnel_id), None)
    if st is None:
        raise HTTPException(status_code=500, detail="Status nicht ermittelbar")
    return st


@app.get("/api/config", response_model=ConfigFile)
def api_get_config() -> ConfigFile:
    return manager.load()


@app.put("/api/config", response_model=ConfigFile)
def api_put_config(cfg: ConfigFile) -> ConfigFile:
    manager.stop_all()
    manager.save(cfg)
    manager.reconcile()
    return manager.load()


@app.get("/monitor/stack", response_class=PlainTextResponse)
def monitor_stack() -> PlainTextResponse:
    """Für Uptime Kuma: 200 nur wenn alle aktivierten Tunnel laufen."""
    manager.reconcile()
    for s in manager.list_status():
        if s.enabled and not s.running:
            return PlainTextResponse("unhealthy", status_code=503)
    return PlainTextResponse("ok")


@app.get("/monitor/tunnel/{tunnel_id}", response_class=PlainTextResponse)
def monitor_tunnel(tunnel_id: str) -> PlainTextResponse:
    """200 wenn deaktiviert oder (aktiviert und läuft); 503 wenn aktiviert aber down."""
    manager.reconcile()
    t = manager.get_tunnel(tunnel_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Tunnel unbekannt")
    if not t.enabled:
        return PlainTextResponse("disabled")
    for s in manager.list_status():
        if s.id == tunnel_id:
            if s.running:
                return PlainTextResponse("ok")
            return PlainTextResponse("down", status_code=503)
    return PlainTextResponse("unknown", status_code=503)


static_path = settings.static_dir
if static_path.is_dir():
    app.mount("/assets", StaticFiles(directory=static_path), name="assets")


@app.get("/")
def index() -> FileResponse:
    index_file = static_path / "index.html"
    if not index_file.is_file():
        raise HTTPException(status_code=500, detail="UI fehlt")
    return FileResponse(index_file)
