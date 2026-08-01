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
    /// Shares the host's day-to-day powers — playback, queue, moderation — but
    /// not the ones that reshape or hand over the room itself.
    Cohost,
    Host,
}

impl Role {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "host" => Self::Host,
            // `moderator` is the pre-playercn spelling. Rows are migrated, but a
            // token, a cached snapshot or another node mid-deploy can still
            // present the old name, and silently demoting a co-host to guest
            // would be worse than accepting both spellings.
            "cohost" | "moderator" => Self::Cohost,
            "member" => Self::Member,
            _ => Self::Guest,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Cohost => "cohost",
            Self::Member => "member",
            Self::Guest => "guest",
        }
    }

    /// Host or co-host: the people who run the room.
    pub fn is_staff(self) -> bool {
        self >= Self::Cohost
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
    /// Promote a member to co-host, or demote one back. Host-only: letting a
    /// co-host mint co-hosts makes the rank self-propagating, and the host
    /// loses control of their own room without ever acting.
    pub can_manage_roles: bool,
    /// Nominate who inherits the room when the host leaves.
    pub can_designate_successor: bool,
    /// Change the room's theme for everybody in it.
    pub can_set_room_theme: bool,
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
        can_manage_roles: host,
        can_designate_successor: host,
        can_set_room_theme: host,
    }
}

/// Can `actor` act on `target`?
///
/// Strictly greater, never equal: two co-hosts must not be able to kick each
/// other, and nobody outranks the host.
pub fn outranks(actor: Role, target: Role) -> bool {
    actor > target
}

/// The order the room falls back through when the host leaves without a usable
/// successor: the most senior rank first, and within a rank the person who has
/// been in the room longest.
///
/// Returned as a sort key so callers can order participants directly. Lower
/// sorts first, i.e. is closer to inheriting the room.
pub fn succession_key(role: Role, joined_at: i64) -> (u8, i64) {
    let rank = match role {
        // The outgoing host is never their own successor.
        Role::Host => 3,
        Role::Cohost => 0,
        Role::Member => 1,
        Role::Guest => 2,
    };
    (rank, joined_at)
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
        assert!(Role::Host > Role::Cohost);
        assert!(Role::Cohost > Role::Member);
        assert!(Role::Member > Role::Guest);
    }

    #[test]
    fn unknown_role_strings_degrade_to_guest() {
        assert_eq!(Role::parse("superadmin"), Role::Guest);
        assert_eq!(Role::parse(""), Role::Guest);
        assert_eq!(Role::parse("host"), Role::Host);
    }

    #[test]
    fn the_pre_rename_moderator_spelling_still_resolves_to_cohost() {
        // A stale row or an in-flight frame from a node that has not restarted
        // must not silently demote someone to guest.
        assert_eq!(Role::parse("moderator"), Role::Cohost);
        assert_eq!(Role::parse("cohost"), Role::Cohost);
    }

    #[test]
    fn role_strings_round_trip() {
        for role in [Role::Guest, Role::Member, Role::Cohost, Role::Host] {
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
        assert!(p.can_manage_roles);
        assert!(p.can_designate_successor);
        assert!(p.can_set_room_theme);
    }

    #[test]
    fn cohost_runs_the_room_but_cannot_reshape_or_hand_it_over() {
        let p = resolve(Role::Cohost, &locked_down());
        assert!(p.can_control_playback);
        assert!(p.can_kick);
        assert!(p.can_moderate_chat);
        assert!(!p.can_edit_room, "only the host reconfigures a room");
        assert!(!p.can_transfer_host, "only the host hands the room over");
        assert!(!p.can_set_room_theme, "the room's look is the host's call");
    }

    #[test]
    fn a_cohost_cannot_mint_more_cohosts() {
        // Otherwise the rank propagates itself and the host loses the room
        // without ever having acted.
        assert!(!resolve(Role::Cohost, &open()).can_manage_roles);
        assert!(!resolve(Role::Cohost, &open()).can_designate_successor);
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
            assert!(!p.can_manage_roles);
        }
    }

    #[test]
    fn everyone_can_vote_to_skip() {
        for role in [Role::Guest, Role::Member, Role::Cohost, Role::Host] {
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
        assert!(!outranks(Role::Cohost, Role::Cohost));
        assert!(!outranks(Role::Member, Role::Member));
        assert!(!outranks(Role::Cohost, Role::Host));
        assert!(outranks(Role::Host, Role::Cohost));
        assert!(outranks(Role::Cohost, Role::Member));
    }

    #[test]
    fn succession_prefers_cohosts_then_the_longest_present() {
        let mut candidates = [
            ("late guest", succession_key(Role::Guest, 400)),
            ("early member", succession_key(Role::Member, 100)),
            ("late cohost", succession_key(Role::Cohost, 300)),
            ("early cohost", succession_key(Role::Cohost, 200)),
        ];
        candidates.sort_by_key(|(_, key)| *key);

        let order: Vec<&str> = candidates.iter().map(|(name, _)| *name).collect();
        assert_eq!(
            order,
            ["early cohost", "late cohost", "early member", "late guest"]
        );
    }

    #[test]
    fn the_departing_host_sorts_last_and_never_inherits_from_themselves() {
        let mut candidates = [
            succession_key(Role::Host, 0),
            succession_key(Role::Guest, 9_999),
        ];
        candidates.sort();
        assert_eq!(candidates[0], succession_key(Role::Guest, 9_999));
    }
}
