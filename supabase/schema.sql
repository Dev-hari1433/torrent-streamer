-- Run once in the SQL editor of your own Supabase project.
create table if not exists public.watch_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  info_hash text not null check (info_hash ~ '^[a-f0-9]{40}$'),
  name text not null check (length(name) between 1 and 500),
  position double precision not null default 0 check (position >= 0),
  duration double precision not null default 0 check (duration >= 0),
  bookmarked boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, info_hash)
);
alter table public.watch_history enable row level security;
revoke all on public.watch_history from anon;
grant select, insert, update, delete on public.watch_history to authenticated;
create policy "Read own history" on public.watch_history for select to authenticated using ((select auth.uid()) = user_id);
create policy "Insert own history" on public.watch_history for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own history" on public.watch_history for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Delete own history" on public.watch_history for delete to authenticated using ((select auth.uid()) = user_id);
create index if not exists watch_history_recent on public.watch_history(user_id, updated_at desc);
