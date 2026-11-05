"""Create (or promote) the first platform administrator, offline.

Phase 7 (ADR-0014) deliberately offers **no HTTP bootstrap**: production has no
endpoint that can grant administrative rights, because an unauthenticated
privilege-grant endpoint would defeat the entire authorization model. The first
administrator is therefore created by an operator running this script with
direct database access — the same trust boundary as running Alembic.

The script is idempotent and auditable:

* an account with the given email is created, or its ``is_platform_admin``
  flag is raised (never lowered — this script grants, it never revokes);
* a suspended account or membership is **never reactivated implicitly**;
  reactivation requires the matching explicit flag;
* an existing membership role is **never changed implicitly**; a role change
  requires ``--allow-role-change`` and is recorded with its previous and
  resulting values;
* every change is recorded in the audit trail in the same transaction as the
  row change, including the actor, the previous state, and the resulting state
  (``users.bootstrap_admin`` / ``users.membership_upserted``).

No password is involved anywhere: DataDiet stores no credentials, and identity
is proven by a signed bearer token verified server-side.

Usage (from ``backend/``)::

    ..\\.venv\\Scripts\\python.exe ..\\scripts\\bootstrap_admin.py ^
        --email admin@example.org --display-name "Ops Admin" ^
        --actor "ops:your-name" --institution-id 1 --role admin

Run it against the same ``DATABASE_URL`` / ``.env`` as the API.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

# Allow running as a plain script from backend/ or the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.db.models import AppUser, Institution, UserMembership  # noqa: E402
from app.db.session import get_engine  # noqa: E402
from app.services.audit import record_event  # noqa: E402

ROLE_CHOICES = ("viewer", "reviewer", "admin")
_LEGACY_DEFAULT_ACTOR = "offline_operator"


class BootstrapError(RuntimeError):
    """A safe, operator-facing refusal or validation failure."""


def _normalise_email(value: str) -> str:
    cleaned = value.strip().lower()
    if "@" not in cleaned or cleaned.startswith("@") or cleaned.endswith("@"):
        raise argparse.ArgumentTypeError("email must look like an email address")
    return cleaned


def validate_actor(value: str) -> str:
    """Require an explicit, meaningful operator identity for the audit trail."""
    actor = value.strip()
    if not actor:
        raise ValueError("actor must identify the operator; it cannot be blank")
    if actor == _LEGACY_DEFAULT_ACTOR:
        raise ValueError(
            "actor must identify the operator, not the legacy default "
            f"{_LEGACY_DEFAULT_ACTOR!r}"
        )
    if len(actor) > 120:
        raise ValueError("actor must be at most 120 characters")
    return actor


def _arg_actor(value: str) -> str:
    try:
        return validate_actor(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def _validation_summary(exc: ValidationError) -> str:
    """Field-level configuration errors with input values and URLs omitted."""
    errors = exc.errors(include_input=False, include_url=False)
    parts: list[str] = []
    for error in errors:
        location = ".".join(str(part) for part in error.get("loc", ())) or "<root>"
        parts.append(f"{location}: {error.get('msg', 'invalid value')}")
    return "; ".join(parts)[:500]


def _safe_failure(exc: BaseException) -> str:
    """Return a concise failure description that cannot contain credentials."""
    if isinstance(exc, BootstrapError):
        return str(exc)
    if isinstance(exc, ValidationError):
        return f"configuration is invalid ({_validation_summary(exc)})"
    if isinstance(exc, SQLAlchemyError):
        return (
            f"database error ({type(exc).__name__}); check DATABASE_URL and "
            "database connectivity"
        )
    return f"unexpected error ({type(exc).__name__})"


def _user_action(promote: bool, reactivate: bool) -> str | None:
    if promote and reactivate:
        return "promoted_and_reactivated"
    if promote:
        return "promoted"
    if reactivate:
        return "reactivated"
    return None


def _membership_action(
    previous_role: str, previous_active: bool, role: str, reactivate: bool, allow_role_change: bool
) -> str | None:
    role_changed = previous_role != role
    if not previous_active and not reactivate:
        raise BootstrapError(
            "The membership is suspended. Pass --reactivate-membership to "
            "reactivate it; no change was made."
        )
    if role_changed and not allow_role_change:
        raise BootstrapError(
            f"The membership currently has role {previous_role!r}; refusing to "
            f"change it to {role!r} without --allow-role-change. No change was made."
        )
    if not previous_active and role_changed:
        return "reactivated_and_role_changed"
    if not previous_active:
        return "reactivated"
    if role_changed:
        return "role_changed"
    return None


def bootstrap(
    db: Session,
    *,
    email: str,
    display_name: str,
    institution_id: int | None,
    role: str,
    actor: str,
    reactivate_user: bool = False,
    reactivate_membership: bool = False,
    allow_role_change: bool = False,
) -> int:
    """Create/promote the administrator account; return its id.

    All validation is performed before the first row is changed. All database
    changes and their audit events commit together: a crash cannot leave an
    account without its audit entry or vice versa.
    """
    actor = validate_actor(actor)
    if role not in ROLE_CHOICES:
        raise BootstrapError(f"role must be one of {list(ROLE_CHOICES)}")

    user = db.execute(select(AppUser).where(AppUser.email == email)).scalar_one_or_none()
    user_created = user is None

    
    institution = None
    membership = None
    if institution_id is not None:
        institution = db.get(Institution, institution_id)
        if institution is None:
            raise BootstrapError(
                f"Institution #{institution_id} does not exist; create it first or "
                "omit --institution-id."
            )
        if not user_created:
            assert user is not None
            membership = db.execute(
                select(UserMembership).where(
                    UserMembership.app_user_id == user.id,
                    UserMembership.institution_id == institution_id,
                )
            ).scalar_one_or_none()

    previous_admin = False
    previous_active = False
    if user is not None:
        previous_admin = bool(user.is_platform_admin)
        previous_active = bool(user.is_active)
        if not previous_active and not reactivate_user:
            raise BootstrapError(
                f"Account <{email}> is suspended. Pass --reactivate-user to "
                "reactivate it; no change was made."
            )

    promote = user is None or not previous_admin
    reactivate = user is not None and not previous_active and reactivate_user
    user_action = _user_action(promote, reactivate)

    membership_action: str | None = None
    previous_membership_role: str | None = None
    previous_membership_active = False
    if institution_id is not None:
        if membership is None:
            membership_action = "created"
        else:
            previous_membership_role = membership.role
            previous_membership_active = bool(membership.is_active)
            membership_action = _membership_action(
                membership.role,
                bool(membership.is_active),
                role,
                reactivate_membership,
                allow_role_change,
            )

    messages: list[str] = []

    if user is None:
        user = AppUser(
            email=email,
            display_name=display_name,
            is_platform_admin=True,
            is_active=True,
        )
        db.add(user)
        db.flush()
        record_event(
            db,
            actor=actor,
            event_type="users.bootstrap_admin",
            entity_type="app_user",
            entity_id=user.id,
            payload={
                "action": "created",
                "email": email,
                "via": "offline_script",
                "previous": {
                    "exists": False,
                    "is_platform_admin": False,
                    "is_active": False,
                },
                "resulting": {
                    "exists": True,
                    "is_platform_admin": True,
                    "is_active": True,
                },
            },
            commit=False,
        )
        messages.append(f"Created platform administrator account #{user.id} <{email}>.")
    else:
        changed = False
        if not user.is_platform_admin:
            user.is_platform_admin = True
            changed = True
        if not user.is_active and reactivate_user:
            user.is_active = True
            changed = True
        if changed:
            assert user_action is not None
            record_event(
                db,
                actor=actor,
                event_type="users.bootstrap_admin",
                entity_type="app_user",
                entity_id=user.id,
                payload={
                    "action": user_action,
                    "email": email,
                    "via": "offline_script",
                    "previous": {
                        "exists": True,
                        "is_platform_admin": previous_admin,
                        "is_active": previous_active,
                    },
                    "resulting": {
                        "exists": True,
                        "is_platform_admin": bool(user.is_platform_admin),
                        "is_active": bool(user.is_active),
                    },
                },
                commit=False,
            )
            if user_action == "promoted_and_reactivated":
                messages.append(
                    f"Promoted and reactivated existing account #{user.id} <{email}>."
                )
            elif user_action == "promoted":
                messages.append(f"Promoted existing account #{user.id} <{email}>.")
            else:
                messages.append(f"Reactivated existing account #{user.id} <{email}>.")
        else:
            messages.append(
                f"Account #{user.id} <{email}> is already an active platform administrator."
            )

    if institution_id is not None:
        if membership is None:
            db.add(
                UserMembership(
                    app_user_id=user.id,
                    institution_id=institution_id,
                    role=role,
                    is_active=True,
                    created_by=actor,
                )
            )
            record_event(
                db,
                actor=actor,
                event_type="users.membership_upserted",
                entity_type="user_membership",
                entity_id=f"{user.id}:{institution_id}",
                payload={
                    "action": "created",
                    "institution_id": institution_id,
                    "via": "offline_script",
                    "previous": {
                        "exists": False,
                        "role": None,
                        "is_active": False,
                    },
                    "resulting": {"role": role, "is_active": True},
                },
                commit=False,
            )
            messages.append(f"Granted role '{role}' in institution #{institution_id}.")
        else:
            changed = False
            if membership.role != role:
                membership.role = role
                changed = True
            if not membership.is_active:
                membership.is_active = True
                changed = True
            if changed:
                assert membership_action is not None
                record_event(
                    db,
                    actor=actor,
                    event_type="users.membership_upserted",
                    entity_type="user_membership",
                    entity_id=f"{user.id}:{institution_id}",
                    payload={
                        "action": membership_action,
                        "institution_id": institution_id,
                        "via": "offline_script",
                        "previous": {
                            "exists": True,
                            "role": previous_membership_role,
                            "is_active": previous_membership_active,
                        },
                        "resulting": {
                            "role": membership.role,
                            "is_active": bool(membership.is_active),
                        },
                    },
                    commit=False,
                )
                messages.append(
                    f"Updated membership in institution #{institution_id} "
                    f"(action: {membership_action})."
                )
            else:
                messages.append(
                    f"Membership already active '{role}' in institution #{institution_id}."
                )

    db.commit()
    for message in messages:
        print(message)
    return user.id


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create or promote the first DataDiet platform administrator (offline)."
    )
    parser.add_argument("--email", required=True, type=_normalise_email)
    parser.add_argument(
        "--display-name",
        default=None,
        help="Defaults to the local part of the email address.",
    )
    parser.add_argument(
        "--institution-id",
        type=int,
        default=None,
        help="Optional: also grant an active membership in this institution.",
    )
    parser.add_argument(
        "--role",
        choices=ROLE_CHOICES,
        default="admin",
        help="Role for the optional membership (default: admin).",
    )
    parser.add_argument(
        "--actor",
        required=True,
        type=_arg_actor,
        help=(
            "Required audit identity, for example 'ops:alice'. The legacy "
            "default 'offline_operator' is refused."
        ),
    )
    parser.add_argument(
        "--reactivate-user",
        action="store_true",
        help="Explicitly reactivate a suspended account (never implicit).",
    )
    parser.add_argument(
        "--reactivate-membership",
        action="store_true",
        help="Explicitly reactivate a suspended membership (never implicit).",
    )
    parser.add_argument(
        "--allow-role-change",
        action="store_true",
        help="Explicitly authorize a change to an existing membership role.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI, returning a non-zero code on every failure."""
    args = _build_parser().parse_args(argv)
    try:
        # Build the engine explicitly so a misconfigured environment fails
        # before any change is attempted. The exception is sanitized below.
        engine = get_engine()
        factory = sessionmaker(bind=engine, expire_on_commit=False)
        display_name = args.display_name or args.email.split("@")[0]

        with factory() as db:
            user_id = bootstrap(
                db,
                email=args.email,
                display_name=display_name,
                institution_id=args.institution_id,
                role=args.role,
                actor=args.actor,
                reactivate_user=args.reactivate_user,
                reactivate_membership=args.reactivate_membership,
                allow_role_change=args.allow_role_change,
            )
    except (BootstrapError, ValidationError, SQLAlchemyError) as exc:
        print(f"Bootstrap failed: {_safe_failure(exc)}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - CLI boundary must never echo raw exceptions
        print(f"Bootstrap failed: {_safe_failure(exc)}", file=sys.stderr)
        return 1

    print(
        f"Done. Account id: {user_id}. Sign in by issuing a token whose `sub`/`email` "
        f"claim matches {args.email}; the directory, not the token, grants authority."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
