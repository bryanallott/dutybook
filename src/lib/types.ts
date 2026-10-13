export interface Club {
  id: string
  name: string
  beach: string
}

export interface Member {
  id: string
  club_id: string
  full_name: string
  role: 'member' | 'club_admin'
}

export interface MemberPublic {
  id: string
  club_id: string
  full_name: string
  role: string
  tags: { id: string; name: string; expires_on: string | null }[]
}

export interface Tag {
  id: string
  club_id: string
  name: string
}

export interface Post {
  id: string
  club_id: string
  giver_id: string
  duty_date: string
  mode: 'give' | 'trade'
  status: 'open' | 'swopped' | 'removed'
  created_at: string
  giver?: MemberPublic
}

export interface Offer {
  id: string
  post_id: string
  from_id: string
  kind: 'take' | 'trade'
  trade_date: string | null
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn'
  created_at: string
  from?: MemberPublic
}

export interface Swop {
  id: string
  post_id: string
  giver_id: string
  taker_id: string
  trade_date: string | null
  confirmed_at: string
  captain_told_at: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancel_told_at: string | null
  post?: Post
}

export interface AppEvent {
  id: string
  club_id: string
  actor_id: string
  kind: string
  post_id: string | null
  swop_id: string | null
  summary: string
  created_at: string
}

export interface Notification {
  id: string
  member_id: string
  body: string
  read_at: string | null
  emailed_at: string | null
  created_at: string
}

export type Tab = 'open' | 'post' | 'myswops' | 'history' | 'invite'
