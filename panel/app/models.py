from __future__ import annotations

from pydantic import BaseModel, Field, field_validator, model_validator


class Tunnel(BaseModel):
    id: str = Field(..., min_length=1, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    name: str = ""
    enabled: bool = False
    ssh_user: str
    ssh_host: str
    ssh_port: int = 22
    identity_file: str | None = None

    @field_validator("identity_file", mode="before")
    @classmethod
    def empty_identity_none(cls, v: object) -> object:
        if v == "":
            return None
        return v
    monitor_port: int = Field(default=20000, ge=0, le=65535)
    remote_forward: str = Field(
        ...,
        description=(
            "Ein Argument für ssh -R: klassisch host:hostport (z. B. 2200:localhost:22), "
            "oder nur *:PORT / PORT für dynamischen Remote-Forward (SOCKS auf dem SSH-Server)."
        ),
    )
    extra_ssh_args: list[str] = Field(default_factory=list)


class TunnelStatus(BaseModel):
    id: str
    name: str
    enabled: bool
    running: bool
    pid: int | None = None


class ConfigFile(BaseModel):
    tunnels: list[Tunnel] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_ids(self) -> ConfigFile:
        seen: set[str] = set()
        for t in self.tunnels:
            if t.id in seen:
                raise ValueError(f"doppelte Tunnel-ID: {t.id}")
            seen.add(t.id)
        return self
