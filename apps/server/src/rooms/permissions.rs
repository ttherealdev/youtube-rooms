//! Room authorisation.
//!
//! Every mutating action — HTTP *and* every socket message — resolves
//! permissions through this module. The client's copy is a rendering hint;
//! hiding a button is not authorisation (ADR 0007).
//!
//! This module is pure, so the entire policy is exhaustively testable without
//! a database.

use crate::db::rooms::RoomSettings;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Guest,
    Member,
    Moderator,
    Host,
}

impl Role {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "host" => Self::Host,
            "moderator" => Self::Moderator,
            "member" => Self::Member,
            _ => Self::Guest,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Moderator => "moderator",
            Self::Member => "member",
            Self::Guest => "guest",
        }
    }

    pub fn is_staff(self) -> bool {
        self >= Self::Moderator
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub can_control_playback: bool,
    pub can_manage_queue: bool,
    pub can_invite: bool,
    pub can_kick: bool,
    pub can_moderate_chat: bool,
    pub can_edit_room: bool,
    /// Vote-skip is the pressure valve that makes a host-controlled room
    /// tolerable, so it stays available to everyone who can be in the room.
    pub can_vote_skip: bool,
    pub can_transfer_host: bool,
}

/// Resolve what a role may do in a room, given that room's settings.
///
/// The interesting cases are all about guests: a guest can always talk, react
/// and vote, but touching playback or the queue is gated behind explicit
/// room settings, because an invite link is a public door.
pub fn resolve(role: Role, settings: &RoomSettings) -> Permissions {
    let staff = role.is_staff();
    let host = role == Role::Host;

    Permissions {
        can_control_playback: staff
            || (role == Role::Member && settings.allow_guest_control)
            || (role == Role::Guest && settings.allow_guest_control),

        can_manage_queue: staff
            || (role == Role::Member && settings.allow_guest_queue)
            || (role == Role::Guest && settings.allow_guest_queue),

        can_invite: role >= Role::Member,
        can_kick: staff,
        can_moderate_chat: staff,
        can_edit_room: host,
        can_vote_skip: true,
        can_transfer_host: host,
    }
}

/// Can `actor` act on `target`?
///
/// Strictly greater, never equal: two moderators must not be able to kick each
/// other, and nobody outranks the host.
pub fn outranks(actor: Role, target: Role) -> bool {
    actor > target
}

#[cfg(test)]
mod tests {
    use super::*;

    fn locked_down() -> RoomSettings {
        RoomSettings {
            allow_guest_control: false,
            allow_guest_queue: false,
            ..RoomSettings::default()
        }
    }

    fn open() -> RoomSettings {
        RoomSettings {
            allow_guest_control: true,
            allow_guest_queue: true,
            ..RoomSettings::default()
        }
    }

    #[test]
    fn roles_are_ordered() {
        assert!(Role::Host > Role::Moderator);
        assert!(Role::Moderator > Role::Member);
        assert!(Role::Member > Role::Guest);
    }

    #[test]
    fn unknown_role_strings_degrade_to_guest() {
        assert_eq!(Role::parse("superadmin"), Role::Guest);
        assert_eq!(Role::parse(""), Role::Guest);
        assert_eq!(Role::parse("host"), Role::Host);
    }

    #[test]
    fn role_strings_round_trip() {
        for role in [Role::Guest, Role::Member, Role::Moderator, Role::Host] {
            assert_eq!(Role::parse(role.as_str()), role);
        }
    }

    #[test]
    fn host_can_do_everything() {
        let p = resolve(Role::Host, &locked_down());
        assert!(p.can_control_playback);
        assert!(p.can_manage_queue);
        assert!(p.can_kick);
        assert!(p.can_edit_room);
        assert!(p.can_transfer_host);
    }

    #[test]
    fn moderator_can_moderate_but_not_reconfigure_the_room() {
        let p = resolve(Role::Moderator, &locked_down());
        assert!(p.can_control_playback);
        assert!(p.can_kick);
        assert!(p.can_moderate_chat);
        assert!(!p.can_edit_room, "only the host reconfigures a room");
        assert!(!p.can_transfer_host, "only the host hands the room over");
    }

    #[test]
    fn locked_room_denies_guests_playback_and_queue() {
        let p = resolve(Role::Guest, &locked_down());
        assert!(!p.can_control_playback);
        assert!(!p.can_manage_queue);
        assert!(!p.can_kick);
        assert!(!p.can_edit_room);
    }

    #[test]
    fn open_room_grants_guests_playback_and_queue() {
        let p = resolve(Role::Guest, &open());
        assert!(p.can_control_playback);
        assert!(p.can_manage_queue);
        // Still not moderation — "open" is about participation, not power.
        assert!(!p.can_kick);
        assert!(!p.can_moderate_chat);
        assert!(!p.can_edit_room);
    }

    #[test]
    fn settings_never_grant_moderation_to_non_staff() {
        for role in [Role::Guest, Role::Member] {
            let p = resolve(role, &open());
            assert!(!p.can_kick);
            assert!(!p.can_moderate_chat);
            assert!(!p.can_edit_room);
            assert!(!p.can_transfer_host);
        }
    }

    #[test]
    fn everyone_can_vote_to_skip() {
        for role in [Role::Guest, Role::Member, Role::Moderator, Role::Host] {
            assert!(resolve(role, &locked_down()).can_vote_skip);
        }
    }

    #[test]
    fn guests_cannot_invite_but_members_can() {
        assert!(!resolve(Role::Guest, &open()).can_invite);
        assert!(resolve(Role::Member, &locked_down()).can_invite);
    }

    #[test]
    fn peers_cannot_act_on_each_other() {
        assert!(!outranks(Role::Moderator, Role::Moderator));
        assert!(!outranks(Role::Member, Role::Member));
        assert!(!outranks(Role::Moderator, Role::Host));
        assert!(outranks(Role::Host, Role::Moderator));
        assert!(outranks(Role::Moderator, Role::Member));
    }
}
