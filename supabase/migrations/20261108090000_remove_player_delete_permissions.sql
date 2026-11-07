-- Post-launch hardening: signed-in players can no longer delete cloud saves or
-- backups themselves.
--
-- The app never deletes either table's rows: saving, conflicts, upgrades and
-- imports only add backups and update saves. So the permission only ever
-- helped someone holding a stolen session, who could have wiped a player's
-- save and every backup that would let it be restored.
--
-- Still deleted, as before:
--   - When an account is deleted (Authentication -> Users), its save and
--     backups go with it: the foreign keys cascade, and that doesn't use the
--     player's permissions.
--   - Old backups beyond each reason's limit, by private.prune_save_backups(),
--     which runs as its owner (security definer).
--
-- Unchanged: players still read their own save and backups, create and update
-- their own save (per column), add their own backups (per column), and run
-- public.import_browser_save, which keeps relying on SELECT and INSERT on
-- save_backups to confirm its backup. profiles is left as it is until the app
-- uses it. No rows are changed or removed.
--
-- A cloud reset or account deletion from the app (Stage 10) will need its own
-- checked function rather than this permission.

drop policy if exists "Users can delete their own save" on public.quest_saves;
drop policy if exists "Users can delete their own backups" on public.save_backups;

revoke delete on table public.quest_saves from authenticated;
revoke delete on table public.save_backups from authenticated;

comment on table public.quest_saves is
  'One game save per user. RLS limits each user to their own row. Users can read, create and update their own save, but not delete it.';
comment on table public.save_backups is
  'Read-only copies of game saves. RLS limits each user to their own backups. Users can read and add their own, but never change or delete one.';
