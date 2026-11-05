"""Shared pytest fixtures for the DataDiet backend test suite."""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable, Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.db import models
from app.db import session as sess
from app.db.session import get_db
from app.main import create_app

#: ``DATABASE_URL`` exactly as the caller supplied it. When it is set (for
#: example to a disposable MySQL instance) it is respected; when it is absent
#: every test gets its own temporary SQLite file, so nothing — no asset, no
#: membership, no decision — can leak from one test into another.
_EXTERNAL_DATABASE_URL = os.environ.get("DATABASE_URL")

API = "/api/v1"

#: Synthetic account the default ``client`` fixture signs in as. It is a
#: *platform administrator* so Phase 1-6 regression tests keep exercising the
#: whole surface; tenant-scoping tests create their own scoped accounts.
TEST_ADMIN_EMAIL = "platform.admin@datadiet.test"


def _setup_database() -> str | None:
    """Point the application at this test's database.

    Returns the temporary file to delete afterwards, or ``None`` when the
    caller supplied a database of their own.
    """
    get_settings.cache_clear()
    os.environ.setdefault("ENVIRONMENT", "test")
    if _EXTERNAL_DATABASE_URL is None or ":memory:" in _EXTERNAL_DATABASE_URL:
        fd, path = tempfile.mkstemp(suffix=".db", prefix="datadiet_test_")
        os.close(fd)
        os.environ["DATABASE_URL"] = f"sqlite:///{path}"
        created: str | None = path
    else:
        os.environ["DATABASE_URL"] = _EXTERNAL_DATABASE_URL
        created = None
    sess.dispose_engine()
    models.Base.metadata.create_all(bind=sess.get_engine())
    return created


def _teardown_database(created: str | None) -> None:
    sess.dispose_engine()
    if created is not None:
        os.environ.pop("DATABASE_URL", None)
        try:
            os.remove(created)
        except OSError:  # pragma: no cover - best effort cleanup
            pass
    get_settings.cache_clear()


def _sign_in(test_client: TestClient, **overrides: object) -> dict[str, object]:
    """Sign in through the real development provider and return the response body."""
    payload: dict[str, object] = {
        "email": TEST_ADMIN_EMAIL,
        "display_name": "Platform Administrator",
        "platform_admin": True,
    }
    payload.update(overrides)
    response = test_client.post(f"{API}/auth/dev-login", json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    test_client.headers["Authorization"] = f"Bearer {body['access_token']}"
    return body


def seed_identity_directory(factory: sessionmaker[Session]) -> int:
    """Install the account the default ``client`` fixture's token maps onto.

    A few test modules build their own database and swap it into the session
    factory (``test_db`` / ``setup_test_db``) so they do not share the
    fixture's SQLite file. Authorization reads the *local user directory*, and
    that directory lives in whichever database is currently wired in — so those
    setups must call this as well, or every request is an anonymous 401.

    The seeded account is a platform administrator, so those tests keep
    exercising the whole Phase 1-6 surface exactly as before Phase 7.
    """
    with factory() as db:
        existing = db.execute(
            select(models.AppUser).where(models.AppUser.email == TEST_ADMIN_EMAIL)
        ).scalar_one_or_none()
        if existing is not None:
            return int(existing.id)
        user = models.AppUser(
            email=TEST_ADMIN_EMAIL,
            display_name="Platform Administrator",
            is_platform_admin=True,
            is_active=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return int(user.id)


@pytest.fixture()
def production_environment(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Run one test under ``ENVIRONMENT=production`` with no signing secret.

    The API must then fail closed (503) on every protected endpoint, refuse the
    development sign-in provider, and still answer health probes — ADR-0014.
    Uses the real settings construction path rather than a stub, so the
    production validators (secret stripping, provider disabling) are exercised.
    """
    monkeypatch.setenv("ENVIRONMENT", "production")
    for name in (
        "AUTH_JWT_SECRET",
        "AUTH_DEV_PROVIDER_ENABLED",
        "AUTH_JWT_ISSUER",
        "AUTH_JWT_AUDIENCE",
    ):
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    try:
        yield
    finally:
        get_settings.cache_clear()


@pytest.fixture()
def db() -> Iterator[Session]:
    """A session on the very database the ``client`` fixture talks to."""
    yield from get_db()


@pytest.fixture()
def client() -> Iterator[TestClient]:
    """HTTP client bound to a fresh app instance, authenticated as a platform admin.

    Phase 7 (ADR-0014): every API route now requires a verified identity, so the
    default fixture signs in through ``POST /auth/dev-login`` and sends the
    resulting bearer token — exercising the same verification path production
    uses. Tests that assert on missing credentials should request
    ``anonymous_client`` instead.
    """
    created = _setup_database()
    app = create_app()
    with TestClient(app) as test_client:
        _sign_in(test_client)
        yield test_client
    _teardown_database(created)


@pytest.fixture()
def anonymous_client(client: TestClient) -> Iterator[TestClient]:
    """The same application and database, but with no credentials attached.

    Seeded by ``client`` so both views see identical data; a second test client
    over the same app is used so removing a header never affects the other.
    """
    with TestClient(client.app) as test_client:
        yield test_client


@pytest.fixture()
def scoped_client(client: TestClient) -> Callable[..., TestClient]:
    """Factory for accounts scoped to one institution and role.

    ``make_client(institution_id, role="viewer", email=None)`` returns a client
    signed in as a *non-platform-admin* account holding that single membership,
    so tests can assert cross-institution isolation and the role/permission
    matrix. The returned clients are never platform administrators.
    """

    def make_client(
        institution_id: int,
        role: str = "viewer",
        email: str | None = None,
    ) -> TestClient:
        account_email = email or f"{role}.{institution_id}@datadiet.test"
        # Bare client (no context manager): it shares the app and therefore the
        # same database as ``client``, and manages its own transport per request.
        test_client = TestClient(client.app)
        _sign_in(
            test_client,
            email=account_email,
            display_name=account_email.split("@")[0],
            institution_id=institution_id,
            role=role,
            platform_admin=False,
        )
        return test_client

    return make_client
