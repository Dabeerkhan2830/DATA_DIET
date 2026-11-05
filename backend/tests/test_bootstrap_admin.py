"""Tests for the offline platform-administrator recovery path (Phase 8).

Migration ``0011`` revokes every ``is_platform_admin`` flag by design, so the
documented recovery step is ``scripts/bootstrap_admin.py``: it promotes one
named account, never mass-grants, and writes its audit event in the same
transaction (ADR-0017, ADR-0018). These tests pin that behaviour.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import models

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "bootstrap_admin.py"


def _load_bootstrap():
    spec = importlib.util.spec_from_file_location("bootstrap_admin_script", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def bootstrap_script():
    return _load_bootstrap()


def _user(db: Session, email: str) -> models.AppUser:
    return db.execute(select(models.AppUser).where(models.AppUser.email == email)).scalar_one()


def _bootstrap_events(db: Session, email: str) -> list[models.AuditEvent]:
    events = db.execute(
        select(models.AuditEvent).where(models.AuditEvent.event_type == "users.bootstrap_admin")
    ).scalars()
    return [event for event in events if event.payload.get("email") == email]


def _revoked_user(db: Session, email: str) -> None:
    """Insert an account in the state migration 0011 leaves behind."""
    db.add(
        models.AppUser(
            email=email,
            display_name=email.split("@")[0],
            is_platform_admin=False,
            is_active=True,
        )
    )
    db.commit()


def test_creates_a_new_platform_administrator_with_audit(
    client, db: Session, bootstrap_script
) -> None:
    email = "created.admin@datadiet.test"

    user_id = bootstrap_script.bootstrap(
        db,
        email=email,
        display_name="Created Admin",
        institution_id=None,
        role="admin",
        actor="ops.test",
    )

    user = _user(db, email)
    assert user.id == user_id
    assert user.is_platform_admin is True
    assert user.is_active is True
    assert [(event.actor, event.payload["action"]) for event in _bootstrap_events(db, email)] == [
        ("ops.test", "created")
    ]


def test_promotes_an_existing_account_after_0011_revocation(
    client, db: Session, bootstrap_script
) -> None:
    revoked = "revoked.admin@datadiet.test"
    untouched = "bystander.admin@datadiet.test"
    _revoked_user(db, revoked)
    _revoked_user(db, untouched)

    bootstrap_script.bootstrap(
        db,
        email=revoked,
        display_name="Revoked Admin",
        institution_id=None,
        role="admin",
        actor="ops.test",
    )

    assert _user(db, revoked).is_platform_admin is True
    assert _user(db, untouched).is_platform_admin is False
    events = _bootstrap_events(db, revoked)
    assert [(event.actor, event.payload["action"]) for event in events] == [
        ("ops.test", "promoted")
    ]
    assert events[0].payload["previous"] == {
        "exists": True,
        "is_platform_admin": False,
        "is_active": True,
    }
    assert events[0].payload["resulting"] == {
        "exists": True,
        "is_platform_admin": True,
        "is_active": True,
    }
    assert _bootstrap_events(db, untouched) == []


def test_promotion_is_idempotent(client, db: Session, bootstrap_script) -> None:
    email = "idempotent.admin@datadiet.test"
    _revoked_user(db, email)

    bootstrap_script.bootstrap(
        db,
        email=email,
        display_name="Idempotent Admin",
        institution_id=None,
        role="admin",
        actor="ops.test",
    )
    bootstrap_script.bootstrap(
        db,
        email=email,
        display_name="Idempotent Admin",
        institution_id=None,
        role="admin",
        actor="ops.test",
    )

    assert _user(db, email).is_platform_admin is True
    assert len(_bootstrap_events(db, email)) == 1


def test_membership_is_upserted_for_the_named_account(
    client, db: Session, bootstrap_script
) -> None:
    institution = models.Institution(code="BSTRP", name="Bootstrap Institute")
    db.add(institution)
    db.commit()
    db.refresh(institution)
    email = "membership.admin@datadiet.test"

    user_id = bootstrap_script.bootstrap(
        db,
        email=email,
        display_name="Membership Admin",
        institution_id=institution.id,
        role="admin",
        actor="ops.test",
    )
    membership = db.execute(
        select(models.UserMembership).where(
            models.UserMembership.app_user_id == user_id,
            models.UserMembership.institution_id == institution.id,
        )
    ).scalar_one()
    assert (membership.role, membership.is_active) == ("admin", True)

    bootstrap_script.bootstrap(
        db,
        email=email,
        display_name="Membership Admin",
        institution_id=institution.id,
        role="viewer",
        actor="ops.test",
        allow_role_change=True,
    )
    membership = db.execute(
        select(models.UserMembership).where(
            models.UserMembership.app_user_id == user_id,
            models.UserMembership.institution_id == institution.id,
        )
    ).scalar_one()
    assert (membership.role, membership.is_active) == ("viewer", True)

    events = db.execute(
        select(models.AuditEvent).where(
            models.AuditEvent.event_type == "users.membership_upserted",
            models.AuditEvent.entity_id == f"{user_id}:{institution.id}",
        )
    ).scalars()
    assert [event.payload["action"] for event in events] == ["created", "role_changed"]


def test_idempotent_run_with_an_active_membership_changes_nothing(
    client, db: Session, bootstrap_script
) -> None:
    institution = models.Institution(code="BIDEM", name="Bootstrap Idempotent")
    db.add(institution)
    db.commit()
    db.refresh(institution)
    email = "idempotent.membership@datadiet.test"

    for _ in range(2):
        bootstrap_script.bootstrap(
            db,
            email=email,
            display_name="Idempotent Membership",
            institution_id=institution.id,
            role="admin",
            actor="ops.test",
        )

    user = _user(db, email)
    membership = db.execute(
        select(models.UserMembership).where(
            models.UserMembership.app_user_id == user.id,
            models.UserMembership.institution_id == institution.id,
        )
    ).scalar_one()
    assert (membership.role, membership.is_active) == ("admin", True)
    assert len(_bootstrap_events(db, email)) == 1
    membership_events = db.execute(
        select(models.AuditEvent).where(
            models.AuditEvent.event_type == "users.membership_upserted",
            models.AuditEvent.entity_id == f"{user.id}:{institution.id}",
        )
    ).scalars().all()
    assert len(membership_events) == 1
    assert membership_events[0].payload["action"] == "created"


def _suspended_user(db: Session, email: str, *, is_admin: bool = False) -> models.AppUser:
    user = models.AppUser(
        email=email,
        display_name=email.split("@")[0],
        is_platform_admin=is_admin,
        is_active=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _membership(
    db: Session,
    *,
    user_id: int,
    institution_id: int,
    role: str,
    is_active: bool,
) -> models.UserMembership:
    membership = models.UserMembership(
        app_user_id=user_id,
        institution_id=institution_id,
        role=role,
        is_active=is_active,
        created_by="test.setup",
    )
    db.add(membership)
    db.commit()
    db.refresh(membership)
    return membership


def _institution(db: Session, code: str) -> models.Institution:
    institution = models.Institution(code=code, name=f"Institution {code}")
    db.add(institution)
    db.commit()
    db.refresh(institution)
    return institution


def test_suspended_account_is_not_reactivated_implicitly(
    client, db: Session, bootstrap_script
) -> None:
    email = "suspended.admin@datadiet.test"
    _suspended_user(db, email)

    with pytest.raises(bootstrap_script.BootstrapError, match="suspended"):
        bootstrap_script.bootstrap(
            db,
            email=email,
            display_name="Suspended Admin",
            institution_id=None,
            role="admin",
            actor="ops.test",
        )

    user = _user(db, email)
    assert user.is_platform_admin is False
    assert user.is_active is False
    assert _bootstrap_events(db, email) == []


def test_suspended_account_requires_explicit_reactivation(
    client, db: Session, bootstrap_script
) -> None:
    email = "reactivate.admin@datadiet.test"
    _suspended_user(db, email)

    bootstrap_script.bootstrap(
        db,
        email=email,
        display_name="Reactivate Admin",
        institution_id=None,
        role="admin",
        actor="ops.test",
        reactivate_user=True,
    )

    user = _user(db, email)
    assert user.is_platform_admin is True
    assert user.is_active is True
    events = _bootstrap_events(db, email)
    assert [event.payload["action"] for event in events] == ["promoted_and_reactivated"]
    assert events[0].payload["previous"] == {
        "exists": True,
        "is_platform_admin": False,
        "is_active": False,
    }
    assert events[0].payload["resulting"] == {
        "exists": True,
        "is_platform_admin": True,
        "is_active": True,
    }


def test_suspended_membership_is_not_reactivated_implicitly(
    client, db: Session, bootstrap_script
) -> None:
    institution = _institution(db, "BSUSP")
    email = "suspended.membership@datadiet.test"
    user = _suspended_user(db, email)
    user.is_active = True
    db.commit()
    _membership(
        db,
        user_id=user.id,
        institution_id=institution.id,
        role="viewer",
        is_active=False,
    )

    with pytest.raises(bootstrap_script.BootstrapError, match="--reactivate-membership"):
        bootstrap_script.bootstrap(
            db,
            email=email,
            display_name="Suspended Membership",
            institution_id=institution.id,
            role="viewer",
            actor="ops.test",
        )

    membership = db.execute(
        select(models.UserMembership).where(
            models.UserMembership.app_user_id == user.id,
            models.UserMembership.institution_id == institution.id,
        )
    ).scalar_one()
    assert (membership.role, membership.is_active) == ("viewer", False)
    assert _user(db, email).is_platform_admin is False
    assert _bootstrap_events(db, email) == []


def test_suspended_membership_requires_explicit_flag(
    client, db: Session, bootstrap_script
) -> None:
    institution = _institution(db, "BSREA")
    email = "reactivate.membership@datadiet.test"
    _revoked_user(db, email)
    user = _user(db, email)
    _membership(
        db,
        user_id=user.id,
        institution_id=institution.id,
        role="viewer",
        is_active=False,
    )

    bootstrap_script.bootstrap(
        db,
        email=email,
        display_name="Reactivate Membership",
        institution_id=institution.id,
        role="viewer",
        actor="ops.test",
        reactivate_membership=True,
    )

    membership = db.execute(
        select(models.UserMembership).where(
            models.UserMembership.app_user_id == user.id,
            models.UserMembership.institution_id == institution.id,
        )
    ).scalar_one()
    assert (membership.role, membership.is_active) == ("viewer", True)
    events = db.execute(
        select(models.AuditEvent).where(
            models.AuditEvent.event_type == "users.membership_upserted",
            models.AuditEvent.entity_id == f"{user.id}:{institution.id}",
        )
    ).scalars().all()
    assert [event.payload["action"] for event in events] == ["reactivated"]
    assert events[0].payload["previous"] == {
        "exists": True,
        "role": "viewer",
        "is_active": False,
    }
    assert events[0].payload["resulting"] == {"role": "viewer", "is_active": True}
    assert events[0].actor == "ops.test"


def test_role_change_requires_explicit_authorization(
    client, db: Session, bootstrap_script
) -> None:
    institution = _institution(db, "BSROL")
    email = "role.change@datadiet.test"
    _revoked_user(db, email)
    user = _user(db, email)
    _membership(
        db,
        user_id=user.id,
        institution_id=institution.id,
        role="admin",
        is_active=True,
    )

    with pytest.raises(bootstrap_script.BootstrapError, match="--allow-role-change"):
        bootstrap_script.bootstrap(
            db,
            email=email,
            display_name="Role Change",
            institution_id=institution.id,
            role="viewer",
            actor="ops.test",
        )
    assert _user(db, email).is_platform_admin is False

    bootstrap_script.bootstrap(
        db,
        email=email,
        display_name="Role Change",
        institution_id=institution.id,
        role="viewer",
        actor="ops.test",
        allow_role_change=True,
    )

    membership = db.execute(
        select(models.UserMembership).where(
            models.UserMembership.app_user_id == user.id,
            models.UserMembership.institution_id == institution.id,
        )
    ).scalar_one()
    assert (membership.role, membership.is_active) == ("viewer", True)
    events = db.execute(
        select(models.AuditEvent).where(
            models.AuditEvent.event_type == "users.membership_upserted",
            models.AuditEvent.entity_id == f"{user.id}:{institution.id}",
        )
    ).scalars().all()
    assert [event.payload["action"] for event in events] == ["role_changed"]
    assert events[0].payload["previous"] == {
        "exists": True,
        "role": "admin",
        "is_active": True,
    }
    assert events[0].payload["resulting"] == {"role": "viewer", "is_active": True}


def test_suspended_membership_role_change_requires_both_flags(
    client, db: Session, bootstrap_script
) -> None:
    institution = _institution(db, "BSBTH")
    email = "both.flags@datadiet.test"
    _revoked_user(db, email)
    user = _user(db, email)
    _membership(
        db,
        user_id=user.id,
        institution_id=institution.id,
        role="admin",
        is_active=False,
    )

    with pytest.raises(bootstrap_script.BootstrapError, match="--reactivate-membership"):
        bootstrap_script.bootstrap(
            db,
            email=email,
            display_name="Both Flags",
            institution_id=institution.id,
            role="viewer",
            actor="ops.test",
            allow_role_change=True,
        )

    bootstrap_script.bootstrap(
        db,
        email=email,
        display_name="Both Flags",
        institution_id=institution.id,
        role="viewer",
        actor="ops.test",
        reactivate_membership=True,
        allow_role_change=True,
    )
    membership = db.execute(
        select(models.UserMembership).where(
            models.UserMembership.app_user_id == user.id,
            models.UserMembership.institution_id == institution.id,
        )
    ).scalar_one()
    assert (membership.role, membership.is_active) == ("viewer", True)
    action = db.execute(
        select(models.AuditEvent).where(
            models.AuditEvent.event_type == "users.membership_upserted",
            models.AuditEvent.entity_id == f"{user.id}:{institution.id}",
        )
    ).scalar_one().payload["action"]
    assert action == "reactivated_and_role_changed"


@pytest.mark.parametrize("actor", ["", "   ", "offline_operator"])
def test_actor_must_be_meaningful(bootstrap_script, actor: str) -> None:
    with pytest.raises(ValueError, match="actor"):
        bootstrap_script.validate_actor(actor)


def _cli_environment(**overrides: str) -> dict[str, str]:
    environment = {
        key: value
        for key, value in os.environ.items()
        if key
        not in {
            "DATABASE_URL",
            "ENVIRONMENT",
            "AUTH_JWT_SECRET",
            "AUTH_DEV_PROVIDER_ENABLED",
            "MIGRATION_TEST_DB_URL",
            "MIGRATION_TEST_ALLOW_DROP",
        }
    }
    environment.update(overrides)
    return environment


def _run_cli(
    *,
    environment: dict[str, str],
    args: list[str] | None = None,
) -> subprocess.CompletedProcess[str]:
    command_args = ["--actor", "ops.test"] if args is None else args
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--email",
            "cli.admin@datadiet.test",
            *command_args,
        ],
        cwd=str(SCRIPT.parent.parent / "backend"),
        env=environment,
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_cli_requires_an_explicit_actor() -> None:
    result = _run_cli(
        environment=_cli_environment(ENVIRONMENT="production"),
        args=[],
    )

    assert result.returncode == 2
    assert "--actor" in result.stderr
    assert result.stderr.count("Traceback") == 0


def test_cli_never_echoes_a_rejected_secret() -> None:
    secret = "ReviewOnlySecret"
    result = _run_cli(
        environment=_cli_environment(
            ENVIRONMENT="production",
            AUTH_JWT_SECRET=secret,
            DATABASE_URL=f"mysql+pymysql://user:{secret}@127.0.0.1:3306/datadiet",
        )
    )

    output = result.stdout + result.stderr
    assert result.returncode == 1
    assert secret not in output
    assert "Traceback" not in output
    assert "AUTH_JWT_SECRET" in output


def test_cli_never_echoes_a_malformed_database_url() -> None:
    secret = "ReviewOnlySecret"
    malformed = f"mysql+pymysql://user:{secret}@[broken/database"
    result = _run_cli(
        environment=_cli_environment(
            ENVIRONMENT="production",
            AUTH_JWT_SECRET="x" * 48,
            DATABASE_URL=malformed,
        )
    )

    output = result.stdout + result.stderr
    assert result.returncode == 1
    assert secret not in output
    assert malformed not in output
    assert "Traceback" not in output


def test_cli_sanitizes_engine_initialisation_failure(
    bootstrap_script, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from sqlalchemy.exc import SQLAlchemyError

    secret = "ReviewOnlyDbSecret"

    def fail_to_build_engine():
        raise SQLAlchemyError(f"could not connect with mysql+pymysql://user:{secret}@host/db")

    monkeypatch.setattr(bootstrap_script, "get_engine", fail_to_build_engine)
    code = bootstrap_script.main(["--email", "cli.admin@datadiet.test", "--actor", "ops.test"])
    captured = capsys.readouterr()
    output = captured.out + captured.err

    assert code == 1
    assert "database error (SQLAlchemyError)" in output
    assert secret not in output
    assert "Traceback" not in output
