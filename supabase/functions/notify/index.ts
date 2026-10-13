// Supabase Edge Function: sends notification emails via Resend.
// Triggered by a database webhook on INSERT into notifications.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const FROM_EMAIL = Deno.env.get('FROM_EMAIL') || 'noreply@dutybook.app'
const APP_URL = Deno.env.get('APP_URL') || 'https://dutybook.pages.dev'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

Deno.serve(async (req) => {
  const payload = await req.json()
  const record = payload.record

  if (!record?.member_id || !record?.body) {
    return new Response('No notification data', { status: 400 })
  }

  // Get member's email from auth.users
  const { data: user } = await supabase.auth.admin.getUserById(record.member_id)
  if (!user?.user?.email) {
    return new Response('No email for member', { status: 404 })
  }

  // Send email via Resend
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `Dutybook <${FROM_EMAIL}>`,
      to: [user.user.email],
      subject: 'Dutybook: ' + record.body.slice(0, 60),
      html: `<p>${record.body}</p><p><a href="${APP_URL}">Open Dutybook</a></p>`,
    }),
  })

  if (res.ok) {
    // Stamp emailed_at
    await supabase
      .from('notifications')
      .update({ emailed_at: new Date().toISOString() })
      .eq('id', record.id)
    return new Response('Sent', { status: 200 })
  } else {
    const err = await res.text()
    console.error('Resend error:', err)
    return new Response('Email failed', { status: 500 })
  }
})
