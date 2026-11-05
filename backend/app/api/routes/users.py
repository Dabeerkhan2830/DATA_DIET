"""User directory and membership management (Phase 7, ADR-0014).

Platform administration only: every route requires the ``users:manage``
permission, which the role matrix grants to no institution role — only an
account flagged ``is_platform_admin`` holds it. Institution admins manage
policies and sources inside their own institution; they do not administer
identities.

Every change to an account or a membership is audited in the same transaction
as the state change, so a role grant can never exist without a recorded actor.
No password or credential is ever accepted, returned, or stored here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.schemas.auth import (
    MembershipRead,
    MembershipUpsert,
    UserCreate,
    UserRead,
    UserUpdate,
)
from app.core.auth import (
    PERMISSION_USERS_MANAGE,
    VALID_ROLES,
    CurrentUser,
    require_permission,
)
from app.db.models import AppUser, Institution, UserMembership
from app.db.session import get_db
from app.services.audit import record_event

router = APIRouter(prefix="/users", tags=["users"])


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


def _require_user(db: Session, user_id: int) -> AppUser:
    user = db.get(AppUser, user_id)
    if user is None:
        raise _not_found("User not found")
    return user


def _membership_read(row: UserMembership) -> MembershipRead:
    return MembershipRead(
        id=row.id,
        app_user_id=row.app_user_id,
        institution_id=row.institution_id,
        role=row.role,
        is_active=row.is_active,
        created_by=row.created_by,
        created_at=row.created_at,
    )


def _user_read(db: Session, user: AppUser) -> UserRead:
    rows = db.execute(
        select(UserMembership)
        .where(UserMembership.app_user_id == user.id)
        .order_by(UserMembership.institution_id.asc())
    ).scalars()
    return UserRead(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        is_active=user.is_active,
        is_platform_admin=user.is_platform_admin,
        memberships=[_membership_read(m) for m in rows],
    )


@router.get("", response_model=list[UserRead], summary="List directory accounts")
def list_users(
    current: CurrentUser = Depends(require_permission(PERMISSION_USERS_MANAGE)),
    db: Session = Depends(get_db),
) -> list[UserRead]:
    rows = db.execute(select(AppUser).order_by(AppUser.email.asc())).scalars().all()
    return [_user_read(db, u) for u in rows]


@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def create_user(
    data: UserCreate,
    current: CurrentUser = Depends(require_permission(PERMISSION_USERS_MANAGE)),
    db: Session = Depends(get_db),
) -> UserRead:
    """Create a directory account. The account starts with no memberships."""
    if db.execute(select(AppUser).where(AppUser.email == data.email)).first() is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"An account with email {data.email!r} already exists",
        )
    user = AppUser(
        email=data.email,
        display_name=data.display_name,
        is_platform_admin=data.is_platform_admin,
        is_active=True,
    )
    db.add(user)
    db.flush()
    record_event(
        db,
        actor=current.email,
        event_type="users.account_created",
        entity_type="app_user",
        entity_id=user.id,
        payload={
            "account_id": user.id,
            "is_platform_admin": data.is_platform_admin,
            # The email is the account's identifier and is needed to make the
            # event meaningful; no credential exists for it (ADR-0014).
            "email": data.email,
        },
        commit=False,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with that email already exists (a concurrent submission won)",
        ) from exc
    db.refresh(user)
    return _user_read(db, user)


@router.patch("/{user_id}", response_model=UserRead)
def update_user(
    user_id: int,
    data: UserUpdate,
    current: CurrentUser = Depends(require_permission(PERMISSION_USERS_MANAGE)),
    db: Session = Depends(get_db),
) -> UserRead:
    """Activate/deactivate an account, correct its name, or grant administration."""
    user = _require_user(db, user_id)

    # Guard against locking every administrator out of the platform.
    if data.is_active is False or data.is_platform_admin is False:
        if user.is_active and user.is_platform_admin:
            remaining = (
                db.execute(
                    select(AppUser.id).where(
                        AppUser.id != user.id,
                        AppUser.is_platform_admin.is_(True),
                        AppUser.is_active.is_(True),
                    )
                )
                .scalars()
                .all()
            )
            if not remaining:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "This is the last active platform administrator; promote another "
                        "account before deactivating or demoting it."
                    ),
                )

    changes: dict[str, object] = {}
    if data.display_name is not None:
        user.display_name = data.display_name
        changes["display_name"] = data.display_name
    if data.is_active is not None:
        user.is_active = data.is_active
        changes["is_active"] = data.is_active
    if data.is_platform_admin is not None:
        user.is_platform_admin = data.is_platform_admin
        changes["is_platform_admin"] = data.is_platform_admin

    if changes:
        db.add(user)
        record_event(
            db,
            actor=current.email,
            event_type="users.account_updated",
            entity_type="app_user",
            entity_id=user.id,
            payload={"account_id": user.id, **changes},
            commit=False,
        )
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="Concurrent update, retry"
            ) from exc
        db.refresh(user)
    return _user_read(db, user)


@router.put("/{user_id}/memberships", response_model=UserRead)
def upsert_membership(
    user_id: int,
    data: MembershipUpsert,
    current: CurrentUser = Depends(require_permission(PERMISSION_USERS_MANAGE)),
    db: Session = Depends(get_db),
) -> UserRead:
    """Grant a role in one institution, or change an existing membership."""
    user = _require_user(db, user_id)
    if db.get(Institution, data.institution_id) is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Institution {data.institution_id} does not exist",
        )
    if data.role not in VALID_ROLES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"role must be one of {sorted(VALID_ROLES)}",
        )

    existing = db.execute(
        select(UserMembership).where(
            UserMembership.app_user_id == user.id,
            UserMembership.institution_id == data.institution_id,
        )
    ).scalar_one_or_none()

    if existing is None:
        membership = UserMembership(
            app_user_id=user.id,
            institution_id=data.institution_id,
            role=data.role,
            is_active=data.is_active,
            created_by=current.email,
        )
        db.add(membership)
        event_type = "users.membership_granted"
        payload: dict[str, object] = {
            "account_id": user.id,
            "membership_institution_id": data.institution_id,
            "role": data.role,
            "is_active": data.is_active,
        }
    else:
        if existing.role == data.role and existing.is_active == data.is_active:
            return _user_read(db, user)
        event_type = "users.membership_changed"
        payload = {
            "account_id": user.id,
            "membership_institution_id": existing.institution_id,
            "previous_role": existing.role,
            "role": data.role,
            "previous_is_active": existing.is_active,
            "is_active": data.is_active,
        }
        existing.role = data.role
        existing.is_active = data.is_active
        db.add(existing)

    record_event(
        db,
        actor=current.email,
        event_type=event_type,
        entity_type="user_membership",
        entity_id=user.id,
        payload=payload,
        commit=False,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Concurrent membership change, retry",
        ) from exc
    db.refresh(user)
    return _user_read(db, user)


@router.delete("/{user_id}/memberships/{membership_id}", response_model=UserRead)
def revoke_membership(
    user_id: int,
    membership_id: int,
    current: CurrentUser = Depends(require_permission(PERMISSION_USERS_MANAGE)),
    db: Session = Depends(get_db),
) -> UserRead:
    """Revoke one institution membership (the row is preserved, marked inactive)."""
    user = _require_user(db, user_id)
    membership = db.get(UserMembership, membership_id)
    if membership is None or membership.app_user_id != user.id:
        raise _not_found("Membership not found")

    payload = {
        "account_id": user.id,
        "membership_institution_id": membership.institution_id,
        "role": membership.role,
    }
    if membership.is_active:
        membership.is_active = False
        db.add(membership)
        record_event(
            db,
            actor=current.email,
            event_type="users.membership_revoked",
            entity_type="user_membership",
            entity_id=membership.id,
            payload=payload,
            commit=False,
        )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Concurrent membership change, retry",
        ) from exc
    db.refresh(user)
    return _user_read(db, user)
