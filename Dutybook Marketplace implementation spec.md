# Dutybook Marketplace: implementation spec

Oct 13, 2026 · @Bryan Allott

We're building a web app where Clifton lifeguards swop duty days with each other, hosted for free on Supabase and Cloudflare Pages, and piloted with one club for one season.

Right now swops happen in the club WhatsApp group. Someone asks at 9pm, it gets buried, two people say yes, or nobody does. The captain finds out on the day. The app fixes one thing: a clear record of who agreed to cover which day.

It stays deliberately dumb. Members tag their own qualifications, people judge for themselves whether a swop works, and the person giving away the day tells their captain on WhatsApp. The app checks nothing and approves nothing.

## Scope

The pilot ships what the prototype already does, just with a real database behind it so everyone sees the same thing.

In:

- Join through an email invite from a club admin, then add your name and qualification tags
- Club admins can invite new members
- Post a day, either giving it away or wanting a day back
- Offer to take a day, or offer a day back in trade
- The person giving the day accepts one offer, and the others are declined automatically
- After a swop is confirmed, a ready-made WhatsApp message for the captain, plus a "told my captain" tick
- Either person can cancel; the day goes back on the list
- Email notifications from day one: offers, swops and cancellations
- A history of everything, which nobody can edit
- One beach (Clifton), and a duty is just a date, no times

Out, on purpose:

- Captains in the app. They hear about swops on WhatsApp, the same as now.
- Rule checking. Tags are information, not gates.
- The official roster and volunteer hours. That's a different system and a much bigger job.
- More than one club or beach. The data model leaves room for it, but there's no UI for it.
- SMS of any kind, for login or anything else. No push notifications to phones either, for now.
- Phone numbers. The app doesn't store them anywhere. The club already has everyone on WhatsApp.

## Stack

There's no server of our own. The browser talks straight to Supabase, and Postgres enforces who can do what.

| Piece | What it does | Why |
| --- | --- | --- |
| Cloudflare Pages | Hosts the static site (HTML, JS, CSS) | Free, fast in SA, deploys from a GitHub push |
| Supabase Auth | Email magic-link login | Free; no passwords, no SMS |
| Supabase Postgres | Members, invites, posts, offers, history | Relational data, with row-level security doing the access control |
| Postgres functions (RPC) | Join club, invite, accept, cancel | Anything touching more than one row runs as one transaction |
| Supabase Realtime | Live updates to the Open days list | Two people looking at the same day see it go at the same moment |
| Supabase Edge Function | Sends invite and notification emails | Keeps the email API key out of the browser |
| Resend | Email delivery, for magic links (as Supabase's SMTP) and notifications | Free tier is 3,000 a month, capped at 100 a day ([Resend limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)) |
| Cloudflare Worker (cron) | Weekly database ping | Stops Supabase pausing the project in the off-season |

For the frontend: plain TypeScript with Vite, and maybe Preact if the screens grow. No heavy framework. The prototype's HTML and CSS carry over almost as they are. Most of the work is swapping localStorage for Supabase calls.

Two Supabase projects, dev and prod. That uses up both free slots, so nothing else goes on this account.

## Data model

There are ten tables. The thing to notice is that a confirmed swop gets its own row, separate from the post. That way a cancelled swop stays on record, and the post just goes back to open.

| Table | Key columns | Notes |
| --- | --- | --- |
| clubs | id, name, beach | One row for the pilot (Clifton). |
| members | id (= auth user id), club\_id, full\_name, role (member / club\_admin), created\_at | No phone number. Email lives in Supabase Auth, not here. The first club\_admin is set by hand in the dashboard. |
| invites | id, club\_id, email, invited\_by, expires\_at, accepted\_at | Only a club\_admin can create one. Valid 14 days, and only one open invite per email. |
| tags | id, club\_id, name | The club's qualification list. Seeded with the 9 tags from the prototype. Members can add tags; club admins can rename or remove them. |
| member\_tags | member\_id, tag\_id, expires\_on (nullable) | Expiry is optional and shown, never enforced. |
| posts | id, club\_id, giver\_id, duty\_date, mode (give / trade), status (open / swopped / removed), created\_at | A member can only have one open post per date. |
| offers | id, post\_id, from\_id, kind (take / trade), trade\_date, status (pending / accepted / declined / withdrawn), created\_at | trade\_date is required when kind = trade. Only one pending offer per member per post. |
| swops | id, post\_id, giver\_id, taker\_id, trade\_date, confirmed\_at, captain\_told\_at, cancelled\_at, cancelled\_by, cancel\_told\_at | A unique index on post\_id where cancelled\_at is null means a post can only have one live swop. |
| events | id, club\_id, actor\_id, kind, post\_id, swop\_id, summary, created\_at | The history. Insert-only, written by the functions, never by the browser. |
| notifications | id, member\_id, body, read\_at, emailed\_at, created\_at | Drives the badge on My swops and the emails. |

Dates are stored as plain date, with no time zone. A duty is a day at Clifton, so there's nothing to convert.

## Security

The browser holds the public anon key, so anyone can call the database directly. Row-level security is the only thing standing in the way. Turn RLS on for every table and deny by default.

What the browser can do directly:

- Read members (name and tags only, through a `member_public` view), tags, open posts, and offers on posts in its own club
- Read its own row in members, its own swops and its own notifications
- Insert a post as itself, and insert an offer as itself on someone else's open post
- Withdraw its own pending offer, remove its own open post, and mark its own notifications read

Everything else goes through `security definer` functions, each one checking `auth.uid()` before it touches anything:

| Function | What it does |
| --- | --- |
| `create_invite(email)` | club\_admin only, checked inside the function. Creates the invite, and the Edge Function emails the sign-in link. |
| `join_club(name, tag_ids, new_tag)` | Looks for an unexpired invite for the logged-in email. If there is one, creates the member and their tags and marks the invite used. If not, one plain message: "Ask a club admin to invite you." |
| `accept_offer(offer_id)` | Locks the post row, checks it's still open and that you're the giver. Then it creates the swop, declines the other offers, and writes the events and notifications. All in one transaction, so two accepts can't both win. |
| `cancel_swop(swop_id)` | Giver or taker only. Sets cancelled\_at, reopens the post, notifies the other person. |
| `mark_captain_told(swop_id, kind)` | Giver only. Stamps captain\_told\_at or cancel\_told\_at. |
| `swop_contact(swop_id)` | Returns the other person's email, but only while the swop is live and you're in it. |

Invites are tied to an email address, so there's no shared code to leak. The admin check runs in the database, not in the page. The browser only ever sees someone's email through `swop_contact`. Phone numbers aren't stored anywhere.

## Flows

Every flow is one of these moves on a duty day. Only accepting and cancelling touch more than one row, so those two are the only ones that run as server functions.

&#91;embedded content: life of a duty day · 5 states\]

Accepting locks the post, so two people tapping at the same moment can't both win. The other offers are declined in the same transaction. Withdrawing your own offer just takes it off the list; the day stays open.

## Frontend

Keep the prototype's four tabs and its look exactly. The changes are underneath.

| Screen | Reads | Writes |
| --- | --- | --- |
| Join club (opened from the invite email) | tags | `join_club` |
| Open days | open posts from today on, plus the giver's name and tags; your own pending offers | insert offer, withdraw offer |
| Post | nothing | insert post |
| My swops | your swops, your open posts with their offers, your notifications | `accept_offer`, `cancel_swop`, `mark_captain_told`, `swop_contact` |
| History | the last 100 events, with "load more" | nothing |
| Invite (club admins only) | open and used invites | `create_invite` |

Things to carry over or add:

- Remove the "Viewing as" switcher. Login replaces it.
- Login is a single email field. The magic link opens the app, and the session lasts until they log out. Lifeguards shouldn't be logging in every Saturday.
- Subscribe to Realtime on posts and offers for the club, but only while the Open days or My swops tab is visible. Unsubscribe when the tab is hidden, to save battery and data.
- When an action fails because someone beat you to it (the day was already swopped), say exactly that and refresh the card. Never a generic error.
- Make it installable as a PWA (a manifest and icon), so it sits on the home screen like an app. No offline writes in the pilot.
- Keep the bundle under about 100 KB gzipped. Lots of members are on prepaid data.

## Notifications

Email goes out from day one, alongside the badge on My swops. People won't open the app to check, so the email is what actually gets an offer answered.

These moments create a notification row, and each row sends one email:

- Someone offers on your day
- Your offer is accepted, or declined because the giver chose someone else
- A swop you're in is cancelled
- A post you offered on is taken down

A database webhook on new notification rows calls the Edge Function. It sends through Resend and stamps emailed\_at. Each email is one line saying what happened, plus a link to My swops.

The free cap of 100 a day is shared with login and invite emails. A club this size won't get near it. If it ever does, the sends fail and get logged, and the badge in the app still works.

The captain message isn't a notification. It's a `wa.me` link the giver taps, so it costs nothing and needs no WhatsApp API.

## Free tier and running costs

The pilot costs R0 a month. The free limits are nowhere near a problem, and a weekly ping takes care of the pause.

Supabase's free plan gives each project a 500 MB database, 50,000 monthly active users and two projects. A club of 100 lifeguards will use a few megabytes in a whole season. ([Supabase pricing](https://supabase.com/pricing))

The catch is that free projects pause after about 7 days with too little database activity. Supabase emails a warning about a week ahead, and opening the dashboard keeps it alive. A paused project can be restored, and no data is lost. ([Project pausing](https://supabase.com/docs/guides/platform/free-project-pausing))

What that means in practice:

- In season, daily use keeps it awake anyway.
- Year round, a Cloudflare Worker cron runs once a week and makes one small read against the database, so the project never goes quiet long enough to pause. It's free, and about ten lines of code. If the ping fails, the Worker emails the club admin.
- If the club ever wants it always on without relying on the ping, Supabase Pro is about $25 a month. That's the only real cost on the horizon.

Cloudflare Pages has no realistic limit for a club this size. A custom domain is optional, around R150 to R200 a year. The free `*.pages.dev` address works fine.

Resend's free plan covers the email: 3,000 a month and 100 a day, login links included. Sessions last until people log out, so logins are rare. The free plan allows one verified sending domain.

## Build order

The aim is to get a handful of real lifeguards on it before December, because that's when the swop pressure peaks. That puts roughly four weekends of build ahead of us.

1. Schema, RLS and the six functions in a migration file. Write a SQL test for each policy: can a member read someone else's email? Can a non-admin create an invite? Can they accept an offer on someone else's post? Every one of those should fail.
2. Resend set up as Supabase's SMTP, the invite email, and Join club. Seed Clifton, the tags and the first club\_admin.
3. Open days and Post, wired to the database. Realtime on the list.
4. Offers, accept, and My swops with the captain message.
5. Notification emails, cancel, history, badge.
6. The weekly ping Worker.
7. Deploy to Cloudflare Pages. Ten members try it for two weeks. Fix what breaks.
8. Open it to the whole club.

How we'll know it worked, judged at the end of January:

- Most swops go through the app instead of WhatsApp. Ask the captains, since they'll know.
- No patrol is short because of a swop nobody recorded.
- The "told my captain" tick gets used on most swops. If it doesn't, the nudge isn't working.

## Open questions

- [ ] Who are the first club\_admins? (club)
- [ ] Is there a cut-off for posting a day, say not within 24 hours of the duty, or is last-minute fine? (club)
- [ ] Under POPIA, what's the sign-up consent wording for storing names and emails, and who can delete a member's data? (club)
- [ ] Should members under 18 be allowed to join? If so, does a parent need to consent? (club)
- [ ] Which domain will the emails come from? (club and dev)
