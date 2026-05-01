"""Slice-15 auth endpoints.

`/v1/auth/login` — fake login (any registered user_id, any password). Returns
a HS256 JWT scoped to that user's project list.

`/v1/auth/me` — round-trip the current actor + project so the frontend can
render the topbar (project name, switcher options, logout)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.auth import USER_PROJECTS, USER_ROLES, DEFAULT_ROLE, authenticate_user, mint_token

router = APIRouter()


class LoginRequest(BaseModel):
    user_id: str
    password: str = ""


@router.post("/v1/auth/login")
async def login(body: LoginRequest) -> dict:
    projects = authenticate_user(body.user_id, body.password)
    if projects is None:
        raise HTTPException(status_code=401, detail="unknown user")
    user_id = body.user_id.strip().lower()
    role = USER_ROLES.get(user_id, DEFAULT_ROLE)
    token = mint_token(user_id, projects, role=role)
    return {
        "token": token,
        "actor_id": user_id,
        "projects": projects,
        "role": role,
    }


@router.get("/v1/auth/me")
async def me(request: Request) -> dict:
    return {
        "actor_id": getattr(request.state, "actor_id", None),
        "project_id": getattr(request.state, "project_id", None),
        "projects": getattr(request.state, "projects", []),
        "role": getattr(request.state, "role", None),
    }


@router.get("/v1/auth/users")
async def users() -> dict:
    """Public-ish helper for the demo login screen — surface the seeded users
    so a tester knows which IDs are valid."""
    return {"users": [{"user_id": u, "projects": p} for u, p in USER_PROJECTS.items()]}
