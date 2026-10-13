import './style.css'
import { supabase } from './lib/supabase'
import type { Tab, Post, Offer, MemberPublic, Member } from './lib/types'
import type { RealtimeChannel } from '@supabase/supabase-js'

// ── DOM helpers ──
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!
const show = (el: HTMLElement) => el.removeAttribute('hidden')
const hide = (el: HTMLElement) => el.setAttribute('hidden', '')
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
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
const d = (s: string) => new Date(s + 'T00:00:00')
const fmtDate = (s: string) => d(s).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' })
const fmtMon = (s: string) => d(s).toLocaleDateString('en-ZA', { month: 'short' })
const fmtDay = (s: string) => d(s).getDate()
const fmtTime = (ts: string) => new Date(ts).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const today = () => new Date().toISOString().slice(0, 10)

function dateFlag(date: string) {
  return `<div class="flag" aria-hidden="true"><span class="mo">${fmtMon(date)}</span><span class="dn">${fmtDay(date)}</span></div>`
}

function tagsHtml(tags: { name: string }[]) {
  if (!tags?.length) return ''
  return `<div class="card-tags">${tags.map(t => `<span class="tag">${esc(t.name)}</span>`).join('')}</div>`
}

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
    if (member.role === 'club_admin') {
      show($('#tab-btn-invite'))
      $('#tabs').classList.add('has-invite')
    }
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
const DEV = import.meta.env.DEV
const DEV_PASSWORD = 'dev-local-password-123'

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = ($('#login-email') as HTMLInputElement).value
  const btn = $('#login-form button') as HTMLButtonElement
  const msg = $('#login-msg')
  btn.disabled = true

  if (DEV) {
    // Dev mode: try password sign-in first, then sign-up with password
    const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password: DEV_PASSWORD })
    if (!signInErr) { btn.disabled = false; return }

    const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({ email, password: DEV_PASSWORD })
    btn.disabled = false
    if (signUpErr) {
      // User exists from OTP flow without a password — delete via SQL editor and retry
      showMsg(msg, `${signUpErr.message}. If user was created via magic link, delete from auth.users in the SQL editor and retry.`, 'error')
    } else if (signUpData.session) {
      showMsg(msg, 'Signed up and logged in.', 'success')
    } else {
      showMsg(msg, 'Signed up. Check email or refresh.', 'success')
    }
  } else {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin }
    })
    btn.disabled = false
    if (error) showMsg(msg, error.message, 'error')
    else showMsg(msg, 'Check your email for the magic link.', 'success')
  }
})

// ── Join ──
async function loadJoinTags() {
  const { data: tags } = await supabase.from('tags').select('*').order('name')
  const container = $('#join-tags')
  if (!tags?.length) return
  const group = document.createElement('div')
  group.className = 'checkbox-group'
  for (const t of tags) {
    const label = document.createElement('label')
    label.innerHTML = `<input type="checkbox" name="tags" value="${t.id}" /> ${esc(t.name)}`
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'offers' }, () => {
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
    const modeLabel = p.mode === 'give' ? 'Needs a swop' : 'Available'
    const modeClass = p.mode === 'trade' ? ' trade' : ''

    let actions = ''
    if (isMine) {
      actions = `<div class="card-actions">
        <button class="btn-link small" onclick="window._removePost('${p.id}')">Take down this post</button>
      </div>`
    } else if (myOffer) {
      actions = `<div class="card-actions">
        <span style="color:var(--ok);font-weight:600;font-size:14px">Offer sent</span>
        <button class="btn-link small" onclick="window._withdrawOffer('${myOffer.id}')">Withdraw</button>
      </div>`
    } else if (p.mode === 'give') {
      actions = `<div class="card-actions">
        <button class="btn-primary small" onclick="window._takeDay('${p.id}')">Take this day</button>
      </div>`
    } else {
      actions = `<div class="card-actions">
        <button class="btn-primary small" onclick="window._showOfferForm('${p.id}')">Offer a day back</button>
      </div>`
    }

    return `<article class="card">
      <div class="day-card">
        ${dateFlag(p.duty_date)}
        <div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
            <span class="card-date">${fmtDate(p.duty_date)}</span>
            <span class="card-meta${modeClass}" style="margin:0;white-space:nowrap">${modeLabel}</span>
          </div>
          <div style="margin-top:8px;font-size:15px">${esc(giver?.full_name || 'Unknown')}${isMine ? '<span class="mine-pill">Yours</span>' : ''}</div>
          ${tagsHtml(giver?.tags as { name: string }[] || [])}
          ${actions}
        </div>
      </div>
      <div id="offer-form-${p.id}"></div>
    </article>`
  }).join('')
}

// ── Offer actions ──
;(window as any)._takeDay = async (postId: string) => {
  const { error } = await supabase.from('offers').insert({
    post_id: postId,
    from_id: currentMember!.id,
    kind: 'take'
  })
  if (error) alert(error.message)
  else loadOpenDays()
}

;(window as any)._showOfferForm = (postId: string) => {
  const container = $(`#offer-form-${postId}`)
  container.innerHTML = `<form class="offer-form" onsubmit="window._submitTradeOffer(event, '${postId}')">
    <strong style="display:block;margin-bottom:8px">Which day can you give back?</strong>
    <div class="field"><label>Your duty date</label><input type="date" name="trade_date" min="${today()}" required /></div>
    <div class="row">
      <button type="submit" class="btn-primary small">Send trade offer</button>
      <button type="button" class="btn-ghost small" onclick="this.closest('.offer-form').remove()">Cancel</button>
    </div>
  </form>`
}

;(window as any)._submitTradeOffer = async (e: Event, postId: string) => {
  e.preventDefault()
  const form = e.target as HTMLFormElement
  const tradeDate = (form.querySelector('input[name="trade_date"]') as HTMLInputElement).value
  const { error } = await supabase.from('offers').insert({
    post_id: postId,
    from_id: currentMember!.id,
    kind: 'trade',
    trade_date: tradeDate
  })
  if (error) alert(error.message)
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
  const modeEl = document.querySelector<HTMLInputElement>('input[name="post-mode"]:checked')
  const mode = modeEl?.value || 'give'
  const msg = $('#post-msg')

  if (!date) { showMsg(msg, 'Pick the date of your duty.', 'error'); return }
  if (date < today()) { showMsg(msg, 'That date has passed. Pick an upcoming duty day.', 'error'); return }

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
    showMsg(msg, 'Day posted. It\'s on Open days now.', 'success')
    ;($('#post-form') as HTMLFormElement).reset()
    setTimeout(() => switchTab('open'), 800)
  }
})

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
    return `<div class="${cls}">${esc(n.body)}<time>${fmtTime(n.created_at)}</time></div>`
  }).join('')

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
  if (!swops?.length) { list.innerHTML = '<div class="empty">No confirmed swops yet.</div>'; return }

  const ids = [...new Set(swops.flatMap(s => [s.giver_id, s.taker_id]))]
  const { data: members } = await supabase.from('member_public').select('*').in('id', ids)
  const nameMap = new Map((members || []).map(m => [m.id, m.full_name]))

  list.innerHTML = swops.map(s => {
    const isGiver = s.giver_id === currentMember!.id
    const otherName = esc(nameMap.get(isGiver ? s.taker_id : s.giver_id) || 'Unknown')
    const giverName = esc(nameMap.get(s.giver_id) || 'Unknown')
    const post = s.post as Post
    const line = isGiver ? `${otherName} is covering your shift.` : `You're covering ${giverName}'s shift.`
    const status = s.captain_told_at
      ? `<span class="status-ok">${isGiver ? 'Captain told' : otherName + ' told their captain'}</span>`
      : `<span class="status-wait">${isGiver ? 'Captain not told yet' : otherName + ' still needs to tell their captain'}</span>`

    // Captain message for giver
    const captainMsgText = `Swop confirmed: ${otherName} is covering my ${fmtDate(post.duty_date)} shift at Clifton.${s.trade_date ? ` In return I'm covering their ${fmtDate(s.trade_date)} shift.` : ''}\n– ${giverName}`
    const waLink = `https://wa.me/?text=${encodeURIComponent(captainMsgText)}`

    let captainCard = ''
    if (isGiver && !s.captain_told_at) {
      captainCard = `<div class="captain-card">
        <h3>Tell your captain</h3>
        <p>It was your duty, so this one's on you. Here's a message ready to go.</p>
        <div class="captain-msg">${esc(captainMsgText)}</div>
        <div class="card-actions">
          <a class="btn-dark small" href="${waLink}" target="_blank" rel="noopener">Send on WhatsApp</a>
          <button class="btn-link small" onclick="window._markTold('${s.id}')">I've told my captain</button>
        </div>
      </div>`
    }

    return `${captainCard}<article class="card">
      <div class="day-card">
        ${dateFlag(post.duty_date)}
        <div>
          <div class="card-date">${fmtDate(post.duty_date)}</div>
          <div class="swop-detail">${line}</div>
          ${s.trade_date ? `<div class="swop-detail">${isGiver ? 'You cover' : otherName + ' covers'} ${fmtDate(s.trade_date)} in return.</div>` : ''}
          <div class="swop-detail">${status}</div>
          <div class="card-actions">
            <button class="btn-link small" onclick="window._cancelSwop('${s.id}')">Cancel swop</button>
            <button class="btn-ghost small" onclick="window._getContact('${s.id}')">Get contact</button>
          </div>
        </div>
      </div>
    </article>`
  }).join('')
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
  if (!posts?.length) { list.innerHTML = '<div class="empty">No open posts.</div>'; return }

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
    const modeLabel = p.mode === 'give' ? 'Needs a swop' : 'Available'

    return `<article class="card">
      <div class="day-card">
        ${dateFlag(p.duty_date)}
        <div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
            <span class="card-date">${fmtDate(p.duty_date)}</span>
            <span class="card-meta" style="margin:0">${modeLabel}</span>
          </div>
          <div class="offers-section">
            <strong style="font-size:15px">Offers</strong>
            ${postOffers.length ? postOffers.map(o => {
              const offerer = offererMap.get(o.from_id)
              return `<div class="offer-row">
                <div>
                  <div>${esc(offerer?.full_name || 'Unknown')}</div>
                  ${tagsHtml(offerer?.tags as { name: string }[] || [])}
                  ${o.trade_date ? `<div style="font-size:14px;color:var(--muted)">Gives you back ${fmtDate(o.trade_date)}</div>` : ''}
                </div>
                <button class="btn-primary small" onclick="window._acceptOffer('${o.id}')">Accept</button>
              </div>`
            }).join('') : '<p style="color:var(--muted);font-size:14px;margin:6px 0 0">No offers yet.</p>'}
          </div>
          <div class="card-actions">
            <button class="btn-link small" onclick="window._removePost('${p.id}')">Take down this post</button>
          </div>
        </div>
      </div>
    </article>`
  }).join('')
}

;(window as any)._acceptOffer = async (offerId: string) => {
  const { error } = await supabase.rpc('accept_offer', { p_offer_id: offerId })
  if (error) {
    alert(error.message.includes('already been swopped')
      ? 'Someone else already swopped this day.'
      : error.message)
  } else {
    switchTab('myswops')
    window.scrollTo(0, 0)
  }
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
    if (!append) list.innerHTML = '<div class="empty">No history yet.</div>'
    hide($('#history-more'))
    return
  }

  list.innerHTML += events.map(ev =>
    `<li class="event-row">${esc(ev.summary)}<time>${fmtTime(ev.created_at)}</time></li>`
  ).join('')

  if (events.length === 100) show($('#history-more'))
  else hide($('#history-more'))
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
  if (!invites?.length) { list.innerHTML = '<div class="empty">No invites sent yet.</div>'; return }

  list.innerHTML = invites.map(inv => {
    const status = inv.accepted_at ? 'Accepted' : inv.expires_at < new Date().toISOString() ? 'Expired' : 'Pending'
    const [local, domain] = inv.email.split('@')
    const masked = local[0] + '***@' + domain
    return `<div class="event-row">${esc(masked)} &mdash; ${status}<time>${fmtTime(inv.created_at)}</time></div>`
  }).join('')
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
