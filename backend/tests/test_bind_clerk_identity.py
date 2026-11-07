"""Tests for the offline Clerk identity binding script (Phase 6.0, ADR-0025).

The script is the only supported way a Clerk subject enters the DataDiet
directory, so these tests pin the safety properties the phase was granted on:

* a bind links an *existing* account and never creates one, so a changed email
  address can never produce a second user for the same person;
* a bind never grants authority -- ``is_platform_admin`` and memberships are
  untouched, because roles stay DB-authoritative;
* moving a subject to a different account needs ``--allow-rebind`` and removing
  one needs ``--confirm``;
* every change is written to the audit trail in the same transaction as the row
  change, and a refused operation changes nothing at all;
* the subject is the key, never the email address.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import PROVIDER_CLERK
from app.db import models
from app.db.session import get_db

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "bind_clerk_identity.py"


def _load_binding_script():
    spec = importlib.util.spec_from_file_location("bind_clerk_identity_script", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def binder():
    return _load_binding_script()


@pytest.fixture()
def db(client) -> Iterator[Session]:
    """The isolated SQLite database the ``client`` fixture installs.

    The shared ``db`` fixture follows whatever ``DATABASE_URL`` the settings
    resolve, which in a developer checkout is ``backend/.env`` -- a real MySQL
    instance that is not reachable here. Every test in this module writes, so
    they must run on the throwaway file database instead.
    """
    yield from get_db()


def _account(db: Session, email: str) -> models.AppUser:
    return db.execute(select(models.AppUser).where(models.AppUser.email == email)).scalar_one()


def _binding(db: Session, subject: str) -> models.ExternalIdentity | None:
    return db.execute(
        select(models.ExternalIdentity).where(
            models.ExternalIdentity.provider == PROVIDER_CLERK,
            models.ExternalIdentity.external_subject == subject,
        )
    ).scalar_one_or_none()


def _events(db: Session, event_type: str) -> list[models.AuditEvent]:
    return list(
        db.execute(
            select(models.AuditEvent).where(models.AuditEvent.event_type == event_type)
        ).scalars()
    )


def _seed(db: Session, email: str, *, platform_admin: bool = False) -> models.AppUser:
    user = models.AppUser(
        email=email,
        display_name=email.split("@")[0],
        is_platform_admin=platform_admin,
        is_active=True,
    )
    db.add(user)
    db.commit()
    return user


def _seed_membership(db: Session, user: models.AppUser, institution_id: int) -> None:
    db.add(
        models.UserMembership(
            app_user_id=user.id,
            institution_id=institution_id,
            role="reviewer",
            is_active=True,
            created_by="seed",
        )
    )
    db.commit()


def test_bind_links_the_subject_and_grants_nothing(binder, db: Session) -> None:
    """The core promise: an identity row, an audit row, and no new authority."""
    user = _seed(db, "alice@datadiet.test")

    result = binder.bind(db, subject="user_2MrAlice", email="alice@datadiet.test", actor="ops:a")

    assert result["action"] == "bound"
    binding = _binding(db, "user_2MrAlice")
    assert binding is not None
    assert binding.app_user_id == user.id
    assert binding.last_email == "alice@datadiet.test"
    assert binding.bound_by == "ops:a"

    after = _account(db, "alice@datadiet.test")
    assert after.is_platform_admin is False, "a bind must never grant platform admin"
    assert db.execute(select(models.UserMembership)).scalars().all() == []

    events = _events(db, "users.clerk_identity_bound")
    assert len(events) == 1
    assert events[0].actor == "ops:a"
    assert events[0].payload["external_subject"] == "user_2MrAlice"
    assert events[0].payload["resulting"]["is_platform_admin"] is False


def test_bind_never_creates_an_account(binder, db: Session) -> None:
    """A sign-in cannot conjure a directory row: the account must already exist."""
    users_before = len(db.execute(select(models.AppUser)).scalars().all())

    with pytest.raises(binder.BindingError, match="bootstrap_admin"):
        binder.bind(db, subject="user_2Ghost", email="ghost@datadiet.test", actor="ops:a")

    assert len(db.execute(select(models.AppUser)).scalars().all()) == users_before
    assert _binding(db, "user_2Ghost") is None
    assert _events(db, "users.clerk_identity_bound") == []


def test_a_changed_email_never_produces_a_second_identity(binder, db: Session) -> None:
    """Re-binding the same subject after an address change updates, not doubles."""
    user = _seed(db, "old.address@datadiet.test")
    binder.bind(db, subject="user_2Moves", email="old.address@datadiet.test", actor="ops:a")

    user.email = "new.address@datadiet.test"
    db.commit()
    result = binder.bind(
        db, subject="user_2Moves", email="new.address@datadiet.test", actor="ops:a"
    )

    assert result["action"] == "already_bound"
    assert result["changed"] is True
    accounts = db.execute(
        select(models.AppUser).where(
            models.AppUser.email.in_(
                ["old.address@datadiet.test", "new.address@datadiet.test"]
            )
        )
    ).scalars().all()
    assert len(accounts) == 1, "the email change must not have created a second account"
    bindings = db.execute(select(models.ExternalIdentity)).scalars().all()
    assert len(bindings) == 1
    assert bindings[0].app_user_id == user.id
    assert bindings[0].last_email == "new.address@datadiet.test"


def test_an_idempotent_rebind_writes_no_audit_event(binder, db: Session) -> None:
    """Nothing changed, so nothing is claimed to have changed."""
    _seed(db, "steady@datadiet.test")
    binder.bind(db, subject="user_2Steady", email="steady@datadiet.test", actor="ops:a")

    result = binder.bind(db, subject="user_2Steady", email="steady@datadiet.test", actor="ops:a")

    assert result == {
        "action": "already_bound",
        "subject": "user_2Steady",
        "app_user_id": result["app_user_id"],
        "email": "steady@datadiet.test",
        "changed": False,
    }
    assert len(_events(db, "users.clerk_identity_bound")) == 1


def test_moving_a_subject_needs_an_explicit_flag(binder, db: Session) -> None:
    """Account takeover is exactly what an unguarded rebind would allow."""
    first = _seed(db, "first@datadiet.test")
    second = _seed(db, "second@datadiet.test")
    binder.bind(db, subject="user_2Shared", email="first@datadiet.test", actor="ops:a")

    with pytest.raises(binder.BindingError, match="allow-rebind"):
        binder.bind(db, subject="user_2Shared", email="second@datadiet.test", actor="ops:b")

    assert _binding(db, "user_2Shared").app_user_id == first.id
    assert _events(db, "users.clerk_identity_rebound") == []

    result = binder.bind(
        db,
        subject="user_2Shared",
        email="second@datadiet.test",
        actor="ops:b",
        allow_rebind=True,
    )

    assert result["action"] == "rebound"
    assert _binding(db, "user_2Shared").app_user_id == second.id
    events = _events(db, "users.clerk_identity_rebound")
    assert len(events) == 1
    assert events[0].payload["previous"]["app_user_id"] == first.id
    assert events[0].payload["resulting"]["app_user_id"] == second.id


def test_rebinding_an_admin_does_not_change_privileges(binder, db: Session) -> None:
    """Even onto a platform admin, a bind only records who the subject is."""
    _seed(db, "admin@datadiet.test", platform_admin=True)
    _seed(db, "plain@datadiet.test")
    binder.bind(db, subject="user_2Admin", email="plain@datadiet.test", actor="ops:a")

    binder.bind(
        db, subject="user_2Admin", email="admin@datadiet.test", actor="ops:a", allow_rebind=True
    )

    assert _account(db, "admin@datadiet.test").is_platform_admin is True
    assert _account(db, "plain@datadiet.test").is_platform_admin is False


def test_unbind_requires_confirmation_and_keeps_the_account(binder, db: Session) -> None:
    user = _seed(db, "leaving@datadiet.test")
    institution = models.Institution(code="UNBIND-TEST", name="Unbind Test", is_active=True)
    db.add(institution)
    db.commit()
    _seed_membership(db, user, institution.id)
    binder.bind(db, subject="user_2Leaving", email="leaving@datadiet.test", actor="ops:a")

    with pytest.raises(binder.BindingError, match="confirm"):
        binder.unbind(db, subject="user_2Leaving", actor="ops:a", confirm=False)

    assert _binding(db, "user_2Leaving") is not None, "a refusal must change nothing"

    result = binder.unbind(db, subject="user_2Leaving", actor="ops:a", confirm=True)

    assert result["action"] == "unbound"
    assert _binding(db, "user_2Leaving") is None
    surviving = _account(db, "leaving@datadiet.test")
    assert surviving.is_platform_admin is False
    assert surviving.is_active is True, "unbinding is not suspending"
    assert len(db.execute(select(models.UserMembership)).scalars().all()) == 1
    assert len(_events(db, "users.clerk_identity_unbound")) == 1


def test_unbinding_an_unknown_subject_is_reported_not_invented(binder, db: Session) -> None:
    result = binder.unbind(db, subject="user_2Never", actor="ops:a", confirm=True)

    assert result["action"] == "not_bound"
    assert _events(db, "users.clerk_identity_unbound") == []


def test_the_subject_is_the_key_and_never_an_email(binder, db: Session) -> None:
    """Refusing an email-looking subject keeps the mutable address out of the key."""
    _seed(db, "key@datadiet.test")

    for rejected in ("", "   ", "alice@example.org", "user_" + "x" * 120):
        with pytest.raises(binder.BindingError):
            binder.bind(db, subject=rejected, email="key@datadiet.test", actor="ops:a")

    assert _events(db, "users.clerk_identity_bound") == []


def test_the_actor_must_be_a_real_operator(binder, db: Session) -> None:
    _seed(db, "actor@datadiet.test")

    for rejected in ("", "   ", "offline_operator", "ops:" + "x" * 60):
        with pytest.raises(binder.BindingError):
            binder.bind(db, subject="user_2Actor", email="actor@datadiet.test", actor=rejected)

    assert _binding(db, "user_2Actor") is None


def test_exactly_one_locator_names_the_account(binder, db: Session) -> None:
    user = _seed(db, "located@datadiet.test")

    with pytest.raises(binder.BindingError, match="exactly one"):
        binder.bind(db, subject="user_2Loc", email="located@datadiet.test", user_id=user.id,
                    actor="ops:a")
    with pytest.raises(binder.BindingError, match="exactly one"):
        binder.bind(db, subject="user_2Loc", email=None, user_id=None, actor="ops:a")

    result = binder.bind(db, subject="user_2Loc", user_id=user.id, actor="ops:a")
    assert result["app_user_id"] == user.id
    assert _binding(db, "user_2Loc").app_user_id == user.id


def test_a_failed_audit_write_leaves_no_binding(binder, db: Session, monkeypatch) -> None:
    """The row and its audit event commit together or not at all."""
    _seed(db, "atomic@datadiet.test")

    def explode(*_args, **_kwargs):
        raise RuntimeError("audit storage unavailable")

    monkeypatch.setattr(binder, "record_event", explode)

    with pytest.raises(RuntimeError):
        binder.bind(db, subject="user_2Atomic", email="atomic@datadiet.test", actor="ops:a")
    db.rollback()

    assert _binding(db, "user_2Atomic") is None


def test_list_is_read_only(binder, db: Session) -> None:
    _seed(db, "listed@datadiet.test", platform_admin=True)
    binder.bind(db, subject="user_2Listed", email="listed@datadiet.test", actor="ops:a")
    events_before = len(db.execute(select(models.AuditEvent)).scalars().all())

    rows = binder.list_bindings(db)

    assert rows == [
        {
            "subject": "user_2Listed",
            "app_user_id": rows[0]["app_user_id"],
            "email": "listed@datadiet.test",
            "display_name": "listed",
            "is_platform_admin": True,
            "bound_by": "ops:a",
        }
    ]
    assert binder.list_bindings(db, subject="user_2Other") == []
    assert (
        len(db.execute(select(models.AuditEvent)).scalars().all()) == events_before
    ), "listing must not write"


def test_cli_reports_success_and_refusals(db: Session, monkeypatch, capsys) -> None:
    """The operator-facing exit codes, with the engine pointed at the test session."""
    module = _load_binding_script()
    _seed(db, "cli@datadiet.test")
    monkeypatch.setattr(module, "get_engine", lambda: db.get_bind())

    assert module.main(["bind", "--subject", "user_2Cli", "--email", "cli@datadiet.test",
                        "--actor", "ops:cli"]) == 0
    assert "No privilege was granted" in capsys.readouterr().out
    assert _binding(db, "user_2Cli") is not None

    assert module.main(["list"]) == 0
    assert "user_2Cli" in capsys.readouterr().out

    assert module.main(["unbind", "--subject", "user_2Cli", "--actor", "ops:cli"]) == 1
    assert "--confirm" in capsys.readouterr().err
    assert _binding(db, "user_2Cli") is not None

    assert module.main(["bind", "--subject", "cli@datadiet.test", "--email", "cli@datadiet.test",
                        "--actor", "ops:cli"]) == 1
    assert "identity key" in capsys.readouterr().err

    assert module.main(["unbind", "--subject", "user_2Cli", "--actor", "ops:cli",
                        "--confirm"]) == 0
    assert _binding(db, "user_2Cli") is None
