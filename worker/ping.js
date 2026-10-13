// Cloudflare Worker: weekly cron to keep Supabase free project awake.
// Schedule: 0 6 * * 1 (every Monday at 06:00 UTC)

export default {
  async scheduled(event, env) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/clubs?select=id&limit=1`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
    })

    if (!res.ok) {
      console.error(`Ping failed: ${res.status}`)
      // Optionally email the admin here
    } else {
      console.log('Ping OK')
    }
  },
}
