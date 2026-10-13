import './style.css'
import { supabase } from './lib/supabase'
import type { Tab, Post, Offer, MemberPublic, Member } from './lib/types'
import type { RealtimeChannel } from '@supabase/supabase-js'

// ── DOM helpers ──
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const show = (el: HTMLElement) => el.removeAttribute('hidden')
const hide = (el: HTMLElement) => el.setAttribute('hidden', '')
const showMsg = (el: HTMLElement, text: string, cls: 'success' | 'error' = 'success') => {
  el.textContent = text
  el.className = `msg ${cls}`
  show(el)
}

// ── State ──
let currentMember: Member | null = null
let clubId: string | null = null
let activeTab: Tab = 'open'
let channel: RealtimeChannel | null = null
let historyOffset = 0

// ── Date formatting ──
const fmtDate = (d: string) => {
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' })
}
const fmtTime = (d: string) => new Date(d).toLocaleString('en-ZA', { dateStyle: 'short', timeStyle: 'short' })
const today = () => new Date().toISOString().slice(0, 10)

// ── Boot ──
async function boot() {
  const { data: { session } } = await supabase.auth.getSession()
  if (session) {
    await loadMember()
  } else {
    showScreen('login')
  }

  supabase.auth.onAuthStateChange(async (_event, session) => {
    if (session) await loadMember()
    else showScreen('login')
  })
}

async function loadMember() {
  const { data: member } = await supabase
    .from('members')
    .select('*')
    .eq('id', (await supabase.auth.getUser()).data.user!.id)
    .single()

  if (member) {
    currentMember = member
    clubId = member.club_id
    if (member.role === 'club_admin') show($('#tab-btn-invite'))
    showScreen('app')
    switchTab('open')
  } else {
    showScreen('join')
    loadJoinTags()
  }
}

function showScreen(name: 'login' | 'join' | 'app') {
  for (const s of document.querySelectorAll<HTMLElement>('.screen')) hide(s)
  show($(`#screen-${name}`))
}

// ── Login ──
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = ($('#login-email') as HTMLInputElement).value
  const btn = $('#login-form button') as HTMLButtonElement
  btn.disabled = true
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
  })
  btn.disabled = false
  const msg = $('#login-msg')
  if (error) showMsg(msg, error.message, 'error')
  else showMsg(msg, 'Check your email for the magic link.', 'success')
})

// ── Join ──
async function loadJoinTags() {
  // Fetch all tags for Clifton (the only club)
  const { data: tags } = await supabase.from('tags').select('*').order('name')
  const container = $('#join-tags')
  if (!tags?.length) return
  const group = document.createElement('div')
  group.className = 'checkbox-group'
  for (const t of tags) {
    const label = document.createElement('label')
    label.innerHTML = `<input type="checkbox" name="tags" value="${t.id}" /> ${t.name}`
    group.appendChild(label)
  }
  container.appendChild(group)
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = ($('#join-name') as HTMLInputElement).value
  const tagIds = Array.from(document.querySelectorAll<HTMLInputElement>('#join-tags input:checked'))
    .map(cb => cb.value)
  const btn = $('#join-form button') as HTMLButtonElement
  btn.disabled = true
  const { error } = await supabase.rpc('join_club', { p_name: name, p_tag_ids: tagIds })
  btn.disabled = false
  const msg = $('#join-msg')
  if (error) showMsg(msg, error.message, 'error')
  else await loadMember()
})

// ── Tab switching ──
$('#tabs').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button')
  if (!btn || !btn.dataset.tab) return
  switchTab(btn.dataset.tab as Tab)
})

function switchTab(tab: Tab) {
  activeTab = tab
  for (const b of document.querySelectorAll<HTMLElement>('#tabs button')) {
    b.classList.toggle('active', b.dataset.tab === tab)
  }
  for (const s of document.querySelectorAll<HTMLElement>('.tab-content')) hide(s)
  show($(`#tab-${tab}`))

  unsubscribe()
  if (tab === 'open') loadOpenDays()
  else if (tab === 'myswops') loadMySwops()
  else if (tab === 'history') { historyOffset = 0; loadHistory() }
  else if (tab === 'invite') loadInvites()
}

// ── Realtime ──
function subscribe() {
  if (channel || !clubId) return
  channel = supabase
    .channel('club-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'posts', filter: `club_id=eq.${clubId}` }, () => {
      if (activeTab === 'open') loadOpenDays()
      if (activeTab === 'myswops') loadMySwops()
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'offers', filter: `post_id=in.(select id from posts where club_id='${clubId}')` }, () => {
      if (activeTab === 'open') loadOpenDays()
      if (activeTab === 'myswops') loadMySwops()
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `member_id=eq.${currentMember?.id}` }, () => {
      updateBadge()
      if (activeTab === 'myswops') loadMySwops()
    })
    .subscribe()
}

function unsubscribe() {
  if (channel) {
    supabase.removeChannel(channel)
    channel = null
  }
}

// ── Open days ──
async function loadOpenDays() {
  subscribe()
  const todayStr = today()
  const { data: posts } = await supabase
    .from('posts')
    .select('*')
    .eq('club_id', clubId!)
    .eq('status', 'open')
    .gte('duty_date', todayStr)
    .order('duty_date')

  const list = $('#open-list')
  const empty = $('#open-empty')

  if (!posts?.length) {
    list.innerHTML = ''
    show(empty)
    return
  }
  hide(empty)

  // Fetch givers and offers
  const giverIds = [...new Set(posts.map(p => p.giver_id))]
  const { data: givers } = await supabase.from('member_public').select('*').in('id', giverIds)
  const giverMap = new Map((givers || []).map(g => [g.id, g as MemberPublic]))

  const postIds = posts.map(p => p.id)
  const { data: offers } = await supabase
    .from('offers')
    .select('*')
    .in('post_id', postIds)
    .eq('status', 'pending')

  const offersByPost = new Map<string, Offer[]>()
  for (const o of (offers || []) as Offer[]) {
    if (!offersByPost.has(o.post_id)) offersByPost.set(o.post_id, [])
    offersByPost.get(o.post_id)!.push(o)
  }

  list.innerHTML = posts.map(p => {
    const giver = giverMap.get(p.giver_id)
    const postOffers = offersByPost.get(p.id) || []
    const myOffer = postOffers.find(o => o.from_id === currentMember?.id)
    const isMine = p.giver_id === currentMember?.id

    return `<div class="card">
      <div class="card-date">${fmtDate(p.duty_date)}</div>
      <div class="card-meta">${giver?.full_name || 'Unknown'} · ${p.mode === 'give' ? 'Giving away' : 'Wants to trade'}</div>
      ${giver?.tags?.length ? `<div class="card-tags">${(giver.tags as { name: string }[]).map(t => `<span class="tag">${t.name}</span>`).join('')}</div>` : ''}
      ${postOffers.length ? `<div class="card-meta">${postOffers.length} offer${postOffers.length > 1 ? 's' : ''}</div>` : ''}
      <div class="card-actions">
        ${isMine ? `<button class="small secondary" onclick="window._removePost('${p.id}')">Remove</button>`
          : myOffer ? `<button class="small secondary" onclick="window._withdrawOffer('${myOffer.id}')">Withdraw offer</button>`
          : `<button class="small" onclick="window._showOfferForm('${p.id}', '${p.mode}')">Make offer</button>`}
      </div>
      <div id="offer-form-${p.id}"></div>
    </div>`
  }).join('')
}

// ── Offer actions (on window for inline onclick) ──
;(window as any)._showOfferForm = (postId: string, mode: string) => {
  const container = $(`#offer-form-${postId}`)
  container.innerHTML = `<form class="offer-form" onsubmit="window._submitOffer(event, '${postId}')">
    <select name="kind">
      <option value="take">Take it</option>
      ${mode === 'trade' ? '<option value="trade">Trade</option>' : ''}
    </select>
    <input type="date" name="trade_date" hidden />
    <button type="submit" class="small">Send</button>
  </form>`
  const select = container.querySelector('select')!
  const dateInput = container.querySelector('input[name="trade_date"]') as HTMLInputElement
  select.addEventListener('change', () => {
    if (select.value === 'trade') { show(dateInput); dateInput.required = true }
    else { hide(dateInput); dateInput.required = false }
  })
}

;(window as any)._submitOffer = async (e: Event, postId: string) => {
  e.preventDefault()
  const form = e.target as HTMLFormElement
  const kind = (form.querySelector('select') as HTMLSelectElement).value
  const tradeDate = (form.querySelector('input[name="trade_date"]') as HTMLInputElement).value || null
  const { error } = await supabase.from('offers').insert({
    post_id: postId,
    from_id: currentMember!.id,
    kind,
    trade_date: tradeDate
  })
  if (error) alert(error.message === '23505' ? 'You already have a pending offer on this day.' : error.message)
  else loadOpenDays()
}

;(window as any)._withdrawOffer = async (offerId: string) => {
  await supabase.from('offers').update({ status: 'withdrawn' }).eq('id', offerId)
  loadOpenDays()
}

;(window as any)._removePost = async (postId: string) => {
  await supabase.from('posts').update({ status: 'removed' }).eq('id', postId)
  loadOpenDays()
}

// ── Post a day ──
$('#post-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const date = ($('#post-date') as HTMLInputElement).value
  const mode = ($('#post-mode') as HTMLSelectElement).value
  const msg = $('#post-msg')
  const { error } = await supabase.from('posts').insert({
    club_id: clubId!,
    giver_id: currentMember!.id,
    duty_date: date,
    mode
  })
  if (error) {
    const text = error.message.includes('posts_one_open_per_date')
      ? 'You already have an open post for this date.'
      : error.message
    showMsg(msg, text, 'error')
  } else {
    showMsg(msg, 'Posted!', 'success')
    ;($('#post-form') as HTMLFormElement).reset()
  }
})

// Set min date to today
;($('#post-date') as HTMLInputElement).min = today()

// ── My swops ──
async function loadMySwops() {
  subscribe()
  await Promise.all([loadNotifications(), loadActiveSwops(), loadMyPosts()])
}

async function loadNotifications() {
  const { data: notifs } = await supabase
    .from('notifications')
    .select('*')
    .eq('member_id', currentMember!.id)
    .order('created_at', { ascending: false })
    .limit(20)

  const container = $('#my-notifications')
  if (!notifs?.length) { container.innerHTML = ''; return }

  container.innerHTML = notifs.map(n => {
    const cls = n.read_at ? 'notif read' : 'notif'
    return `<div class="${cls}" data-id="${n.id}">${n.body} <small>${fmtTime(n.created_at)}</small></div>`
  }).join('')

  // Mark unread as read
  const unread = notifs.filter(n => !n.read_at).map(n => n.id)
  if (unread.length) {
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).in('id', unread)
  }
  updateBadge()
}

async function updateBadge() {
  const { count } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('member_id', currentMember!.id)
    .is('read_at', null)

  const badge = $('#notif-badge')
  if (count && count > 0) {
    badge.textContent = String(count)
    show(badge)
  } else {
    hide(badge)
  }
}

async function loadActiveSwops() {
  const { data: swops } = await supabase
    .from('swops')
    .select('*, post:posts(*)')
    .or(`giver_id.eq.${currentMember!.id},taker_id.eq.${currentMember!.id}`)
    .is('cancelled_at', null)
    .order('confirmed_at', { ascending: false })

  const list = $('#my-swops-list')
  if (!swops?.length) { list.innerHTML = '<p class="empty">No active swops.</p>'; return }

  // Fetch names
  const ids = [...new Set(swops.flatMap(s => [s.giver_id, s.taker_id]))]
  const { data: members } = await supabase.from('member_public').select('*').in('id', ids)
  const nameMap = new Map((members || []).map(m => [m.id, m.full_name]))

  list.innerHTML = swops.map(s => {
    const isGiver = s.giver_id === currentMember!.id
    const otherName = nameMap.get(isGiver ? s.taker_id : s.giver_id) || 'Unknown'
    const post = s.post as Post
    return `<div class="card swop-detail">
      <div class="card-date">${fmtDate(post.duty_date)}</div>
      <div class="card-meta">${isGiver ? `${otherName} is covering` : `You're covering for ${nameMap.get(s.giver_id)}`}</div>
      ${s.trade_date ? `<div class="card-meta">Trade date: ${fmtDate(s.trade_date)}</div>` : ''}
      ${s.captain_told_at ? '<div class="told">Captain told</div>' : ''}
      <div class="card-actions">
        ${!s.captain_told_at && isGiver ? `<button class="small secondary" onclick="window._tellCaptain('${s.id}', '${post.duty_date}', '${otherName}')">Tell captain via WhatsApp</button>` : ''}
        ${isGiver ? `<button class="small" onclick="window._markTold('${s.id}')">Mark captain told</button>` : ''}
        <button class="small danger" onclick="window._cancelSwop('${s.id}')">Cancel swop</button>
        <button class="small secondary" onclick="window._getContact('${s.id}')">Get contact</button>
      </div>
    </div>`
  }).join('')
}

;(window as any)._tellCaptain = (_swopId: string, date: string, takerName: string) => {
  const text = encodeURIComponent(`Hi Captain, I've swopped my duty on ${fmtDate(date)} with ${takerName} via Dutybook.`)
  window.open(`https://wa.me/?text=${text}`, '_blank')
}

;(window as any)._markTold = async (swopId: string) => {
  await supabase.rpc('mark_captain_told', { p_swop_id: swopId, p_kind: 'confirmed' })
  loadMySwops()
}

;(window as any)._cancelSwop = async (swopId: string) => {
  if (!confirm('Cancel this swop? The day will go back on the open list.')) return
  const { error } = await supabase.rpc('cancel_swop', { p_swop_id: swopId })
  if (error) alert(error.message)
  else loadMySwops()
}

;(window as any)._getContact = async (swopId: string) => {
  const { data, error } = await supabase.rpc('swop_contact', { p_swop_id: swopId })
  if (error) alert(error.message)
  else alert(`Contact email: ${data}`)
}

async function loadMyPosts() {
  const { data: posts } = await supabase
    .from('posts')
    .select('*')
    .eq('giver_id', currentMember!.id)
    .eq('status', 'open')
    .order('duty_date')

  const list = $('#my-posts-list')
  if (!posts?.length) { list.innerHTML = '<p class="empty">No open posts.</p>'; return }

  // Fetch offers on my posts
  const postIds = posts.map(p => p.id)
  const { data: offers } = await supabase
    .from('offers')
    .select('*')
    .in('post_id', postIds)
    .eq('status', 'pending')

  const { data: offerers } = offers?.length
    ? await supabase.from('member_public').select('*').in('id', offers.map(o => o.from_id))
    : { data: [] }
  const offererMap = new Map((offerers || []).map(m => [m.id, m as MemberPublic]))

  const offersByPost = new Map<string, Offer[]>()
  for (const o of (offers || []) as Offer[]) {
    if (!offersByPost.has(o.post_id)) offersByPost.set(o.post_id, [])
    offersByPost.get(o.post_id)!.push(o)
  }

  list.innerHTML = posts.map(p => {
    const postOffers = offersByPost.get(p.id) || []
    return `<div class="card">
      <div class="card-date">${fmtDate(p.duty_date)}</div>
      <div class="card-meta">${p.mode === 'give' ? 'Giving away' : 'Trade'}</div>
      ${postOffers.length ? postOffers.map(o => {
        const offerer = offererMap.get(o.from_id)
        return `<div class="offer-row">
          <span>${offerer?.full_name || 'Unknown'} - ${o.kind}${o.trade_date ? ' (' + fmtDate(o.trade_date) + ')' : ''}</span>
          ${offerer?.tags?.length ? `<span class="card-tags">${(offerer.tags as { name: string }[]).map(t => `<span class="tag">${t.name}</span>`).join('')}</span>` : ''}
          <button class="small" onclick="window._acceptOffer('${o.id}')">Accept</button>
        </div>`
      }).join('') : '<div class="card-meta">No offers yet</div>'}
      <div class="card-actions">
        <button class="small secondary" onclick="window._removePost('${p.id}')">Remove post</button>
      </div>
    </div>`
  }).join('')
}

;(window as any)._acceptOffer = async (offerId: string) => {
  const { error } = await supabase.rpc('accept_offer', { p_offer_id: offerId })
  if (error) {
    const text = error.message.includes('already been swopped')
      ? 'Someone else already swopped this day.'
      : error.message
    alert(text)
  }
  loadMySwops()
}

// ── History ──
async function loadHistory(append = false) {
  const { data: events } = await supabase
    .from('events')
    .select('*')
    .eq('club_id', clubId!)
    .order('created_at', { ascending: false })
    .range(historyOffset, historyOffset + 99)

  const list = $('#history-list')
  if (!append) list.innerHTML = ''

  if (!events?.length) {
    if (!append) list.innerHTML = '<p class="empty">No history yet.</p>'
    hide($('#history-more'))
    return
  }

  list.innerHTML += events.map(ev =>
    `<div class="event-row">${ev.summary} <small>${fmtTime(ev.created_at)}</small></div>`
  ).join('')

  if (events.length === 100) {
    show($('#history-more'))
  } else {
    hide($('#history-more'))
  }
}

$('#history-more').addEventListener('click', () => {
  historyOffset += 100
  loadHistory(true)
})

// ── Invite (admin) ──
async function loadInvites() {
  const { data: invites } = await supabase
    .from('invites')
    .select('*')
    .eq('club_id', clubId!)
    .order('created_at', { ascending: false })

  const list = $('#invite-list')
  if (!invites?.length) { list.innerHTML = '<p class="empty">No invites yet.</p>'; return }

  list.innerHTML = invites.map(inv =>
    `<div class="event-row">${inv.email} - ${inv.accepted_at ? 'Accepted' : inv.expires_at < new Date().toISOString() ? 'Expired' : 'Pending'} <small>${fmtTime(inv.created_at)}</small></div>`
  ).join('')
}

$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = ($('#invite-email') as HTMLInputElement).value
  const msg = $('#invite-msg')
  const { error } = await supabase.rpc('create_invite', { p_email: email })
  if (error) showMsg(msg, error.message, 'error')
  else {
    showMsg(msg, `Invite sent to ${email}`, 'success')
    ;($('#invite-form') as HTMLFormElement).reset()
    loadInvites()
  }
})

// ── Logout ──
$('#logout-btn').addEventListener('click', async () => {
  unsubscribe()
  await supabase.auth.signOut()
  currentMember = null
  clubId = null
  showScreen('login')
})

// ── Init ──
boot()
updateBadge().catch(() => {})
