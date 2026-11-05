"""Phase 7 tests: the account directory and membership management.

Every route here is platform-administration only (``users:manage``), which no
institution role grants — it comes from the account's ``is_platform_admin``
flag (ADR-0014). Institution admins administer policies and sources inside
their own tenant; they do not administer identities.

No password is accepted, returned, or stored by any of these endpoints, and
every change to an account or a membership is audited in the same transaction
as the state change.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import models

BASE = "/api/v1"


def _institution(db: Session, code: str) -> int:
    row = models.Institution(code=code, name=f"Institution {code}")
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.id


def _audit(db: Session, event_type: str) -> list[models.AuditEvent]:
    return list(
        db.execute(
            select(models.AuditEvent).where(models.AuditEvent.event_type == event_type)
        )
        .scalars()
        .all()
    )


# --------------------------------------------------------------------------- #
# Permission gate
# --------------------------------------------------------------------------- #


def test_an_institution_admin_cannot_manage_identities(
    client: TestClient, db: Session, scoped_client
) -> None:
    """``users:manage`` is not part of any institution role."""
    institution_id = _institution(db, "USR1")
    admin = scoped_client(institution_id, role="admin")

    denied = admin.get(f"{BASE}/users")
    assert denied.status_code == 403
    assert denied.json()["detail"].startswith("forbidden:")

    created = admin.post(f"{BASE}/users", json={"email": "x@datadiet.test", "display_name": "X"})
    assert created.status_code == 403

    # The refusal is recorded against the caller; the read *and* the write are
    # distinguished (denied writes are audited, denied reads are not).
    events = _audit(db, "authorization.denied")
    assert [e.payload["method"] for e in events] == ["POST"]
    assert events[0].actor == f"admin.{institution_id}@datadiet.test"


def test_a_viewer_cannot_manage_identities(
    client: TestClient, db: Session, scoped_client
) -> None:
    institution_id = _institution(db, "USR2")
    viewer = scoped_client(institution_id, role="viewer")
    assert viewer.get(f"{BASE}/users").status_code == 403
    assert viewer.patch(f"{BASE}/users/1", json={"is_active": False}).status_code == 403


# --------------------------------------------------------------------------- #
# Directory CRUD
# --------------------------------------------------------------------------- #


def test_create_user_and_grant_a_membership(client: TestClient, db: Session) -> None:
    institution_id = _institution(db, "USR3")

    created = client.post(
        f"{BASE}/users",
        json={"email": "New.Person@Datadiet.test", "display_name": "New Person"},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["email"] == "new.person@datadiet.test"  # normalised
    assert body["is_active"] is True
    assert body["is_platform_admin"] is False
    assert body["memberships"] == []

    granted = client.put(
        f"{BASE}/users/{body['id']}/memberships",
        json={"institution_id": institution_id, "role": "reviewer"},
    )
    assert granted.status_code == 200, granted.text
    assert len(granted.json()["memberships"]) == 1
    assert granted.json()["memberships"][0]["role"] == "reviewer"
    assert granted.json()["memberships"][0]["created_by"] == "platform.admin@datadiet.test"

    listed = client.get(f"{BASE}/users").json()
    assert any(u["id"] == body["id"] for u in listed)

    events = _audit(db, "users.account_created") + _audit(db, "users.membership_granted")
    assert len(events) == 2
    # Emails appear because they are the account's identifier; nothing else
    # about the person is recorded, and there is no credential of any kind.
    assert "password" not in json.dumps([e.payload for e in events])
    assert "token" not in json.dumps([e.payload for e in events])


def test_duplicate_email_is_a_conflict(client: TestClient, db: Session) -> None:
    payload = {"email": "dupe@datadiet.test", "display_name": "Dupe"}
    assert client.post(f"{BASE}/users", json=payload).status_code == 201
    assert client.post(f"{BASE}/users", json=payload).status_code == 409


def test_unknown_user_and_institution_are_refused(client: TestClient, db: Session) -> None:
    assert client.patch(f"{BASE}/users/999999", json={"is_active": False}).status_code == 404
    assert (
        client.put(
            f"{BASE}/users/999999/memberships",
            json={"institution_id": 1, "role": "viewer"},
        ).status_code
        == 404
    )
    assert (
        client.put(
            f"{BASE}/users/1/memberships", json={"institution_id": 424242, "role": "viewer"}
        ).status_code
        == 422
    )
    # An unknown role is rejected by the schema before it reaches any logic.
    assert (
        client.put(
            f"{BASE}/users/1/memberships", json={"institution_id": 1, "role": "superuser"}
        ).status_code
        == 422
    )
    # A membership id that belongs to somebody else is a 404, not a leak.
    assert client.delete(f"{BASE}/users/1/memberships/999999").status_code == 404


def test_the_last_platform_administrator_cannot_be_demoted(
    client: TestClient, db: Session
) -> None:
    me = client.get(f"{BASE}/auth/me").json()
    assert me["is_platform_admin"] is True

    demote = client.patch(f"{BASE}/users/{me['id']}", json={"is_platform_admin": False})
    assert demote.status_code == 409
    assert "last active platform administrator" in demote.json()["detail"]

    deactivate = client.patch(f"{BASE}/users/{me['id']}", json={"is_active": False})
    assert deactivate.status_code == 409

    # Promote a second administrator first, and the demotion is allowed.
    created = client.post(
        f"{BASE}/users", json={"email": "second.admin@datadiet.test", "display_name": "Second"}
    ).json()
    promoted = client.patch(f"{BASE}/users/{created['id']}", json={"is_platform_admin": True})
    assert promoted.status_code == 200
    assert promoted.json()["is_platform_admin"] is True

    demoted = client.patch(f"{BASE}/users/{me['id']}", json={"is_platform_admin": False})
    assert demoted.status_code == 200


# --------------------------------------------------------------------------- #
# Membership changes take effect on the next authenticated request
# --------------------------------------------------------------------------- #


def test_a_granted_role_takes_effect_without_reissuing_credentials(
    client: TestClient, db: Session, scoped_client
) -> None:
    """Authorization is read from the directory every request, never from the token."""
    institution_id = _institution(db, "USR4")
    source = models.DataSource(
        institution_id=institution_id, name="src-usr4", source_type="synthetic"
    )
    db.add(source)
    db.commit()
    db.refresh(source)

    # The account holds only 'viewer': no write permission.
    member = scoped_client(institution_id, role="viewer", email="promotable@datadiet.test")
    asset = member.post(
        f"{BASE}/assets",
        json={
            "data_source_id": source.id,
            "external_id": "usr4-1",
            "title": "Nope",
            "record_type": "document",
        },
    )
    assert asset.status_code == 403

    account = db.execute(
        select(models.AppUser).where(models.AppUser.email == "promotable@datadiet.test")
    ).scalar_one()

    # An administrator changes the membership...
    promoted = client.put(
        f"{BASE}/users/{account.id}/memberships",
        json={"institution_id": institution_id, "role": "admin"},
    )
    assert promoted.status_code == 200

    # ...the very same bearer token now yields the higher role, because the
    # token says who, and the directory says what they may do.
    allowed = member.post(
        f"{BASE}/assets",
        json={
            "data_source_id": source.id,
            "external_id": "usr4-2",
            "title": "Fine now",
            "record_type": "document",
        },
    )
    assert allowed.status_code == 201, allowed.text

    changed = _audit(db, "users.membership_changed")
    assert len(changed) == 1
    assert changed[0].payload["previous_role"] == "viewer"
    assert changed[0].payload["role"] == "admin"


def test_revoking_a_membership_removes_access(
    client: TestClient, db: Session, scoped_client
) -> None:
    institution_id = _institution(db, "USR5")
    member = scoped_client(institution_id, role="reviewer", email="revoked@datadiet.test")
    account = db.execute(
        select(models.AppUser).where(models.AppUser.email == "revoked@datadiet.test")
    ).scalar_one()
    membership = db.execute(
        select(models.UserMembership).where(
            models.UserMembership.app_user_id == account.id,
            models.UserMembership.institution_id == institution_id,
        )
    ).scalar_one()

    # Before revocation the account can see the institution's records...
    assert member.get(f"{BASE}/assets?institution_id={institution_id}").status_code == 200

    revoked = client.delete(f"{BASE}/users/{account.id}/memberships/{membership.id}")
    assert revoked.status_code == 200
    assert revoked.json()["memberships"][0]["is_active"] is False

    # ...afterwards the same token has no role at all: with no active
    # membership it holds no permissions, so the request is refused before any
    # scoping question arises (403, not 404 — the caller is known, just
    # unauthorized).
    denied = member.get(f"{BASE}/assets?institution_id={institution_id}")
    assert denied.status_code == 403
    assert denied.json()["detail"].startswith("forbidden:")
    assert _audit(db, "users.membership_revoked")[0].actor == "platform.admin@datadiet.test"


def test_repeated_membership_submission_is_idempotent(
    client: TestClient, db: Session
) -> None:
    institution_id = _institution(db, "USR6")
    created = client.post(
        f"{BASE}/users", json={"email": "idem@datadiet.test", "display_name": "Idem"}
    ).json()
    payload = {"institution_id": institution_id, "role": "viewer"}

    first = client.put(f"{BASE}/users/{created['id']}/memberships", json=payload)
    second = client.put(f"{BASE}/users/{created['id']}/memberships", json=payload)
    assert first.status_code == second.status_code == 200
    assert second.json()["memberships"] == first.json()["memberships"]
    # No audit noise for a submission that changed nothing.
    assert _audit(db, "users.membership_changed") == []
    assert len(_audit(db, "users.membership_granted")) == 1


def test_deactivated_account_cannot_sign_in_afterwards(
    client: TestClient, db: Session
) -> None:
    created = client.post(
        f"{BASE}/users", json={"email": "suspended@datadiet.test", "display_name": "Suspended"}
    ).json()
    suspended = client.patch(f"{BASE}/users/{created['id']}", json={"is_active": False})
    assert suspended.status_code == 200

    response = client.post(f"{BASE}/auth/dev-login", json={"email": "suspended@datadiet.test"})
    assert response.status_code == 403

    listed = client.get(f"{BASE}/users").json()
    assert next(u for u in listed if u["id"] == created["id"])["is_active"] is False
