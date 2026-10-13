-- Dutybook schema, RLS policies, and RPC functions
-- Run against a fresh Supabase project.

-- ============================================================
-- TABLES
-- ============================================================

create table clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  beach text not null,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key references auth.users(id),
  club_id uuid not null references clubs(id),
  full_name text not null,
  role text not null default 'member' check (role in ('member', 'club_admin')),
  created_at timestamptz not null default now()
);

create table invites (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id),
  email text not null,
  invited_by uuid not null references members(id),
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table tags (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (club_id, name)
);

create table member_tags (
  member_id uuid not null references members(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  expires_on date,
  primary key (member_id, tag_id)
);

create table posts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id),
  giver_id uuid not null references members(id),
  duty_date date not null,
  mode text not null check (mode in ('give', 'trade')),
  status text not null default 'open' check (status in ('open', 'swopped', 'removed')),
  created_at timestamptz not null default now()
);
-- One open post per member per date
create unique index posts_one_open_per_date
  on posts (giver_id, duty_date) where status = 'open';

create table offers (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id),
  from_id uuid not null references members(id),
  kind text not null check (kind in ('take', 'trade')),
  trade_date date,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at timestamptz not null default now(),
  constraint trade_date_required check (kind != 'trade' or trade_date is not null)
);
-- One pending offer per member per post
create unique index offers_one_pending_per_member
  on offers (post_id, from_id) where status = 'pending';

create table swops (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references posts(id),
  giver_id uuid not null references members(id),
  taker_id uuid not null references members(id),
  trade_date date,
  confirmed_at timestamptz not null default now(),
  captain_told_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references members(id),
  cancel_told_at timestamptz
);
-- Only one live swop per post
create unique index swops_one_live on swops (post_id) where cancelled_at is null;

create table events (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references clubs(id),
  actor_id uuid not null references members(id),
  kind text not null,
  post_id uuid references posts(id),
  swop_id uuid references swops(id),
  summary text not null,
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id),
  body text not null,
  read_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- VIEW: member_public (name + tags, no email)
-- ============================================================

create view member_public as
  select m.id, m.club_id, m.full_name, m.role,
         coalesce(
           json_agg(json_build_object('id', t.id, 'name', t.name, 'expires_on', mt.expires_on))
             filter (where t.id is not null),
           '[]'::json
         ) as tags
  from members m
  left join member_tags mt on mt.member_id = m.id
  left join tags t on t.id = mt.tag_id
  group by m.id;

-- ============================================================
-- RLS
-- ============================================================

alter table clubs enable row level security;
alter table members enable row level security;
alter table invites enable row level security;
alter table tags enable row level security;
alter table member_tags enable row level security;
alter table posts enable row level security;
alter table offers enable row level security;
alter table swops enable row level security;
alter table events enable row level security;
alter table notifications enable row level security;

-- Helper: get current user's club
create or replace function my_club_id() returns uuid
  language sql stable security definer
  as $$ select club_id from members where id = auth.uid() $$;

-- clubs: any authenticated member can read
create policy "members can read clubs" on clubs
  for select using (auth.role() = 'authenticated');

-- members: read own club members via the view; users read their own row
create policy "read own row" on members
  for select using (id = auth.uid());

create policy "read club members" on members
  for select using (club_id = my_club_id());

-- invites: club_admins see their club's invites
create policy "admins read invites" on invites
  for select using (
    club_id = my_club_id()
    and exists (select 1 from members where id = auth.uid() and role = 'club_admin')
  );

-- tags: anyone in the club can read
create policy "read club tags" on tags
  for select using (club_id = my_club_id());

-- tags: any member can insert
create policy "members insert tags" on tags
  for insert with check (club_id = my_club_id());

-- member_tags: read for club members
create policy "read member tags" on member_tags
  for select using (
    exists (select 1 from members where id = member_tags.member_id and club_id = my_club_id())
  );

-- posts: read open posts in own club
create policy "read club posts" on posts
  for select using (club_id = my_club_id());

-- posts: insert as self
create policy "insert own post" on posts
  for insert with check (giver_id = auth.uid() and club_id = my_club_id());

-- posts: remove own open post
create policy "remove own post" on posts
  for update using (giver_id = auth.uid() and status = 'open')
  with check (status = 'removed');

-- offers: read offers on club posts
create policy "read club offers" on offers
  for select using (
    exists (select 1 from posts where posts.id = offers.post_id and posts.club_id = my_club_id())
  );

-- offers: insert offer on someone else's open post
create policy "insert own offer" on offers
  for insert with check (
    from_id = auth.uid()
    and exists (
      select 1 from posts
      where posts.id = offers.post_id
        and posts.status = 'open'
        and posts.giver_id != auth.uid()
        and posts.club_id = my_club_id()
    )
  );

-- offers: withdraw own pending offer
create policy "withdraw own offer" on offers
  for update using (from_id = auth.uid() and status = 'pending')
  with check (status = 'withdrawn');

-- swops: read own swops
create policy "read own swops" on swops
  for select using (giver_id = auth.uid() or taker_id = auth.uid());

-- events: read club events
create policy "read club events" on events
  for select using (club_id = my_club_id());

-- notifications: read own
create policy "read own notifications" on notifications
  for select using (member_id = auth.uid());

-- notifications: mark own read
create policy "mark own read" on notifications
  for update using (member_id = auth.uid())
  with check (read_at is not null);

-- ============================================================
-- RPC FUNCTIONS
-- ============================================================

-- 1. join_club
create or replace function join_club(
  p_name text,
  p_tag_ids uuid[] default '{}',
  p_new_tag text default null
) returns uuid
language plpgsql security definer
as $$
declare
  v_email text;
  v_invite invites%rowtype;
  v_club_id uuid;
  v_new_tag_id uuid;
begin
  select email into v_email from auth.users where id = auth.uid();

  select * into v_invite from invites
    where email = v_email
      and accepted_at is null
      and expires_at > now()
    order by created_at desc
    limit 1;

  if v_invite is null then
    raise exception 'Ask a club admin to invite you.';
  end if;

  v_club_id := v_invite.club_id;

  insert into members (id, club_id, full_name)
    values (auth.uid(), v_club_id, p_name);

  -- Mark invite used
  update invites set accepted_at = now() where id = v_invite.id;

  -- Optional new tag
  if p_new_tag is not null and p_new_tag != '' then
    insert into tags (club_id, name) values (v_club_id, p_new_tag)
      on conflict (club_id, name) do update set name = excluded.name
      returning id into v_new_tag_id;
    p_tag_ids := array_append(p_tag_ids, v_new_tag_id);
  end if;

  -- Assign tags
  insert into member_tags (member_id, tag_id)
    select auth.uid(), unnest(p_tag_ids);

  -- Event
  insert into events (club_id, actor_id, kind, summary)
    values (v_club_id, auth.uid(), 'member_joined', p_name || ' joined the club');

  return v_club_id;
end;
$$;

-- 2. create_invite
create or replace function create_invite(p_email text)
returns uuid
language plpgsql security definer
as $$
declare
  v_club_id uuid;
  v_invite_id uuid;
begin
  select club_id into v_club_id from members
    where id = auth.uid() and role = 'club_admin';

  if v_club_id is null then
    raise exception 'Only club admins can invite members.';
  end if;

  -- Check for existing open invite
  if exists (
    select 1 from invites
    where email = p_email and club_id = v_club_id
      and accepted_at is null and expires_at > now()
  ) then
    raise exception 'An open invite already exists for this email.';
  end if;

  insert into invites (club_id, email, invited_by)
    values (v_club_id, lower(trim(p_email)), auth.uid())
    returning id into v_invite_id;

  return v_invite_id;
end;
$$;

-- 3. accept_offer
create or replace function accept_offer(p_offer_id uuid)
returns uuid
language plpgsql security definer
as $$
declare
  v_offer offers%rowtype;
  v_post posts%rowtype;
  v_swop_id uuid;
  v_taker_name text;
  v_giver_name text;
begin
  select * into v_offer from offers where id = p_offer_id and status = 'pending';
  if v_offer is null then
    raise exception 'Offer not found or already resolved.';
  end if;

  -- Lock the post
  select * into v_post from posts where id = v_offer.post_id for update;

  if v_post.giver_id != auth.uid() then
    raise exception 'Only the giver can accept offers.';
  end if;

  if v_post.status != 'open' then
    raise exception 'This day has already been swopped.';
  end if;

  -- Create swop
  insert into swops (post_id, giver_id, taker_id, trade_date)
    values (v_post.id, v_post.giver_id, v_offer.from_id,
            case when v_offer.kind = 'trade' then v_offer.trade_date else null end)
    returning id into v_swop_id;

  -- Accept this offer, decline others
  update offers set status = 'accepted' where id = p_offer_id;
  update offers set status = 'declined'
    where post_id = v_post.id and id != p_offer_id and status = 'pending';

  -- Mark post swopped
  update posts set status = 'swopped' where id = v_post.id;

  -- Names for notifications
  select full_name into v_giver_name from members where id = v_post.giver_id;
  select full_name into v_taker_name from members where id = v_offer.from_id;

  -- Notify taker: your offer was accepted
  insert into notifications (member_id, body)
    values (v_offer.from_id,
      v_giver_name || ' accepted your offer for ' || v_post.duty_date);

  -- Notify declined offerers
  insert into notifications (member_id, body)
    select from_id, v_giver_name || ' chose someone else for ' || v_post.duty_date
    from offers
    where post_id = v_post.id and status = 'declined' and id != p_offer_id;

  -- Events
  insert into events (club_id, actor_id, kind, post_id, swop_id, summary)
    values (v_post.club_id, auth.uid(), 'offer_accepted', v_post.id, v_swop_id,
      v_giver_name || ' accepted ' || v_taker_name || '''s offer for ' || v_post.duty_date);

  return v_swop_id;
end;
$$;

-- 4. cancel_swop
create or replace function cancel_swop(p_swop_id uuid)
returns void
language plpgsql security definer
as $$
declare
  v_swop swops%rowtype;
  v_post posts%rowtype;
  v_other_id uuid;
  v_actor_name text;
begin
  select * into v_swop from swops where id = p_swop_id and cancelled_at is null;
  if v_swop is null then
    raise exception 'Swop not found or already cancelled.';
  end if;

  if auth.uid() != v_swop.giver_id and auth.uid() != v_swop.taker_id then
    raise exception 'Only the giver or taker can cancel.';
  end if;

  -- Cancel swop
  update swops set cancelled_at = now(), cancelled_by = auth.uid()
    where id = p_swop_id;

  -- Reopen post
  update posts set status = 'open' where id = v_swop.post_id;

  -- Notify the other person
  v_other_id := case when auth.uid() = v_swop.giver_id then v_swop.taker_id else v_swop.giver_id end;
  select full_name into v_actor_name from members where id = auth.uid();

  select * into v_post from posts where id = v_swop.post_id;

  insert into notifications (member_id, body)
    values (v_other_id,
      v_actor_name || ' cancelled the swop for ' || v_post.duty_date);

  insert into events (club_id, actor_id, kind, post_id, swop_id, summary)
    values (v_post.club_id, auth.uid(), 'swop_cancelled', v_post.id, p_swop_id,
      v_actor_name || ' cancelled the swop for ' || v_post.duty_date);
end;
$$;

-- 5. mark_captain_told
create or replace function mark_captain_told(p_swop_id uuid, p_kind text default 'confirmed')
returns void
language plpgsql security definer
as $$
begin
  if p_kind = 'confirmed' then
    update swops set captain_told_at = now()
      where id = p_swop_id and giver_id = auth.uid() and cancelled_at is null;
  elsif p_kind = 'cancelled' then
    update swops set cancel_told_at = now()
      where id = p_swop_id
        and (giver_id = auth.uid() or taker_id = auth.uid())
        and cancelled_at is not null;
  end if;
end;
$$;

-- 6. swop_contact
create or replace function swop_contact(p_swop_id uuid)
returns text
language plpgsql security definer
as $$
declare
  v_swop swops%rowtype;
  v_other_id uuid;
  v_email text;
begin
  select * into v_swop from swops
    where id = p_swop_id and cancelled_at is null;

  if v_swop is null then
    raise exception 'Swop not found or cancelled.';
  end if;

  if auth.uid() = v_swop.giver_id then
    v_other_id := v_swop.taker_id;
  elsif auth.uid() = v_swop.taker_id then
    v_other_id := v_swop.giver_id;
  else
    raise exception 'You are not part of this swop.';
  end if;

  select email into v_email from auth.users where id = v_other_id;
  return v_email;
end;
$$;

-- ============================================================
-- SEED DATA: Clifton club and default tags
-- ============================================================

insert into clubs (id, name, beach)
  values ('00000000-0000-0000-0000-000000000001', 'Clifton Lifesaving Club', 'Clifton');

insert into tags (club_id, name) values
  ('00000000-0000-0000-0000-000000000001', 'IRB Crew'),
  ('00000000-0000-0000-0000-000000000001', 'IRB Driver'),
  ('00000000-0000-0000-0000-000000000001', 'Surf Lifesaver'),
  ('00000000-0000-0000-0000-000000000001', 'First Aid L1'),
  ('00000000-0000-0000-0000-000000000001', 'First Aid L2'),
  ('00000000-0000-0000-0000-000000000001', 'First Aid L3'),
  ('00000000-0000-0000-0000-000000000001', 'JetSki'),
  ('00000000-0000-0000-0000-000000000001', 'Spinal Board'),
  ('00000000-0000-0000-0000-000000000001', 'AED');

-- Realtime: enable for posts, offers, notifications
alter publication supabase_realtime add table posts;
alter publication supabase_realtime add table offers;
alter publication supabase_realtime add table notifications;
