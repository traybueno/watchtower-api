/**
 * Limits Routes - CCU limit event recording and notification
 * 
 * POST /v1/limits/event - Record a limit event, send email notification
 * 
 * Uses Resend for transactional email.
 * Debounces: Only 1 email per project per hour.
 */

import { Hono } from 'hono'
import type { Env } from '../index'

export const limitsRouter = new Hono<{ Bindings: Env }>()

// CCU limit thresholds by plan
const CCU_LIMITS: Record<string, number> = {
  free: 10,
  pro: 1000,
  scale: 10000,
}

interface LimitEventRequest {
  userId: string
  projectId: string
  gameId: string
  gameName: string
  plan: string
  currentCCU: number
  limit: number
  userEmail: string
}

/**
 * POST /v1/limits/event
 * Called internally from the connect route when a CCU limit is hit.
 * Authenticated via X-Internal-Secret header to prevent external abuse.
 */
limitsRouter.post('/event', async (c) => {
  // Verify internal auth — only accept calls from our own connect route
  const internalSecret = c.req.header('X-Internal-Secret')
  const expectedSecret = c.env.SUPABASE_SERVICE_ROLE_KEY // reuse as internal secret
  if (!internalSecret || internalSecret !== expectedSecret) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json() as LimitEventRequest
  const { userId, projectId, gameId, gameName, plan, currentCCU, limit, userEmail } = body

  if (!userId || !projectId || !userEmail) {
    return c.json({ error: 'Missing required fields' }, 400)
  }
  
  const supabaseUrl = c.env.SUPABASE_URL
  const supabaseKey = c.env.SUPABASE_SERVICE_ROLE_KEY
  const resendKey = c.env.RESEND_API_KEY
  
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials')
    return c.json({ error: 'Server configuration error' }, 500)
  }
  
  try {
    // Check for recent event (debounce - 1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const checkRes = await fetch(
      `${supabaseUrl}/rest/v1/limit_events?project_id=eq.${projectId}&event_type=eq.ccu_limit&occurred_at=gte.${oneHourAgo}&limit=1`,
      {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        }
      }
    )
    
    if (checkRes.ok) {
      const recent = await checkRes.json() as unknown[]
      if (recent.length > 0) {
        // Already sent within the hour, skip
        return c.json({ 
          recorded: false, 
          reason: 'debounced',
          message: 'Event already recorded within the past hour'
        })
      }
    }
    
    // Record the event
    const insertRes = await fetch(
      `${supabaseUrl}/rest/v1/limit_events`,
      {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          user_id: userId,
          project_id: projectId,
          event_type: 'ccu_limit',
          metadata: {
            game_id: gameId,
            game_name: gameName,
            plan,
            current_ccu: currentCCU,
            limit,
          }
        })
      }
    )
    
    if (!insertRes.ok) {
      const err = await insertRes.text()
      console.error('Failed to insert limit event:', err)
      return c.json({ error: 'Failed to record event' }, 500)
    }
    
    // Send email notification via Resend
    let emailSent = false
    if (resendKey && userEmail) {
      try {
        const upgradeUrl = plan === 'free' 
          ? 'https://watchtower.host/dashboard/billing?upgrade=pro'
          : plan === 'pro'
            ? 'https://watchtower.host/dashboard/billing?upgrade=scale'
            : 'https://watchtower.host/dashboard/billing'
        
        const limitLabel = limit.toLocaleString()
        const timestamp = new Date().toLocaleString('en-US', { 
          dateStyle: 'medium', 
          timeStyle: 'short' 
        })
        
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'Watchtower <noreply@watchtower.host>',
            to: [userEmail],
            subject: 'Your game hit the concurrent user limit',
            html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #0a0a0a; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width: 500px; background-color: #18181b; border-radius: 12px; border: 1px solid #27272a;">
          <tr>
            <td style="padding: 32px;">
              <!-- Logo -->
              <div style="text-align: center; margin-bottom: 24px;">
                <span style="color: #10b981; font-size: 20px; font-weight: bold;">Watchtower</span>
              </div>
              
              <!-- Content -->
              <h1 style="color: #fafafa; font-size: 20px; font-weight: 600; margin: 0 0 16px 0; text-align: center;">
                CCU Limit Reached
              </h1>
              
              <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; margin: 0 0 24px 0; text-align: center;">
                Your game <strong style="color: #fafafa;">${gameName || gameId}</strong> hit its concurrent user limit.
              </p>
              
              <!-- Stats -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #27272a; border-radius: 8px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 16px;">
                    <table width="100%">
                      <tr>
                        <td style="color: #71717a; font-size: 12px;">Limit</td>
                        <td style="color: #fafafa; font-size: 14px; text-align: right; font-weight: 500;">${limitLabel} CCU</td>
                      </tr>
                      <tr>
                        <td style="color: #71717a; font-size: 12px; padding-top: 8px;">Time</td>
                        <td style="color: #a1a1aa; font-size: 14px; text-align: right; padding-top: 8px;">${timestamp}</td>
                      </tr>
                      <tr>
                        <td style="color: #71717a; font-size: 12px; padding-top: 8px;">Current Plan</td>
                        <td style="color: #a1a1aa; font-size: 14px; text-align: right; padding-top: 8px; text-transform: capitalize;">${plan}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              ${plan !== 'scale' ? `
              <!-- CTA -->
              <div style="text-align: center;">
                <a href="${upgradeUrl}" style="display: inline-block; background-color: #10b981; color: #000000; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 24px; border-radius: 8px;">
                  Upgrade Now
                </a>
              </div>
              
              <p style="color: #71717a; font-size: 12px; text-align: center; margin: 16px 0 0 0;">
                ${plan === 'free' ? 'Pro: 1,000 CCU for $9/mo' : 'Scale: 10,000 CCU for $25/mo'}
              </p>
              ` : `
              <p style="color: #71717a; font-size: 12px; text-align: center; margin: 0;">
                You're on our highest tier. <a href="mailto:support@watchtower.host" style="color: #10b981;">Contact us</a> for enterprise options.
              </p>
              `}
            </td>
          </tr>
        </table>
        
        <!-- Footer -->
        <p style="color: #52525b; font-size: 11px; margin: 24px 0 0 0; text-align: center;">
          Watchtower • Multiplayer infrastructure for web games
        </p>
      </td>
    </tr>
  </table>
</body>
</html>
            `,
          })
        })
        
        emailSent = emailRes.ok
        if (!emailRes.ok) {
          const err = await emailRes.text()
          console.error('Resend API error:', err)
        }
      } catch (e) {
        console.error('Failed to send email:', e)
      }
    }
    
    return c.json({ 
      recorded: true, 
      emailSent,
      message: 'Limit event recorded'
    })
    
  } catch (e) {
    console.error('Error recording limit event:', e)
    return c.json({ error: 'Internal error' }, 500)
  }
})
