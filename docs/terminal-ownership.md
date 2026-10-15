# Crow terminal ownership by installation

Crow sends a stable, random installation ID from the Windows user's Crow
profile to each remote Crow host. The host stamps newly created terminal
sessions with that owner and scopes listing, input, wake, and close operations
to the same ID. This prevents sessions opened by another Crow profile from
appearing or being operable in this profile, even when both connect with the
same Linux SSH account.

This is a **Crow workflow boundary, not a security boundary**: anyone with shell
access as the same Linux user can read the host bootstrap token or otherwise
operate processes as that user. Strong user isolation requires separate Linux
accounts and OS permissions.

The installation ID is stored in the desktop app's `userData/installation-id`
file. Reinstalling while preserving that profile keeps the identity; deleting
the profile creates a new Crow identity. The client requires the remote host
to support automatic identities, so update the remote Crow service before
connecting from a new desktop version.

Existing terminals created before ownership was introduced are **not
automatically claimed**. Their saved names or project paths are not reliable
proof of which Crow installation created them, so automatic reassignment could
expose another person's work. They need an explicit migration/recovery flow if
they should be retained under the new ownership model.
