import 'dotenv/config'
import express from 'express'
import { seedInitialSuperAdmin } from './lib/seedSuperAdmin.js'
import cors from 'cors'
const app = express()
app.disable('etag')
// N-06: do not advertise the server framework.
app.disable('x-powered-by')
import type { Request, Response, NextFunction } from 'express'
import { Router } from 'express'
import authRouter from './routers/authRouter.js'
import campaignRouter from './routers/campaignRouter.js'
import settingsRouter from './routers/settingsRouter.js'
import userRouter from './routers/userRouter.js'
import trackRouter from './routers/trackRouter.js'
import unsubscribeRouter from './routers/unsubscribeRouter.js'
import emailWebhooks from './webhooks/emailWebhooks.js'
import inboundEmailRouter from './routers/inboundEmailRouter.js'
import repliesRouter from './routers/repliesRouter.js'
import devRouter from './routers/devRouter.js'
import adminRouter from './routers/adminRouter.js'
import followUpRouter from './routers/followUpRouter.js'
import paymentRouter from './routers/paymentRouter.js'
import scriptRouter from './routers/scriptRouter.js'
import crmRouter from './routers/crmRouter.js'
import crmTagsRouter from './routers/crmTagsRouter.js'

import { leadGenAdminRouter, leadGenPublicRouter, leadGenRouter, requireLeadGen } from './routers/leadGenRouter.js'

import webTrackRouter from './routers/webTrackRouter.js'
import formPublicRouter from './routers/formPublicRouter.js'

import { authMiddleware } from './middleware/authMiddleware.js'
import { setCsrfAllowedOrigins } from './middleware/csrf.js'
import { purgeExpiredSessions } from './lib/refreshTokens.js'
import { requirePlanFeature } from './middleware/requirePlanFeature.js'

const isDev = process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_ROUTES === 'true'

// Enable CORS for frontend (production origin from env or localhost for dev).
// N-07: with cookie sessions, the localhost dev origins are allowed only outside production.
const allowedOrigins: string[] = process.env.NODE_ENV === 'production' ? [] : [
    'http://localhost:3001',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:3002',
];
if (process.env.CORS_ORIGIN) {
    allowedOrigins.push(...process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean));
}
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
}))
// The same list decides which pages may use the session cookies (CSRF origin check), plus the API's own host.
setCsrfAllowedOrigins(allowedOrigins)

// N-05: security headers on every API response. Hosted forms (/f/:formKey) stay frameable because
// f.js embeds them in an iframe on customers' sites. Headers for the web app HTML are set in nginx.
app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    if (!req.path.startsWith('/f/')) {
        res.setHeader('X-Frame-Options', 'DENY')
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    }
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    next()
})

// Stripe webhook needs raw body — must be registered BEFORE express.json()
app.use('/api/payment/webhook', express.raw({ type: 'application/json' }))

// Script-generation uploads carry a whole company list (10,000+ rows) — larger
// limit for that one route, registered before the default 100kb parser.
app.use('/api/script-files', express.json({ limit: '25mb' }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Public: payment, auth, tracking, webhooks
app.use('/api', paymentRouter)
app.use('/api', authRouter)
app.use('/api', trackRouter)
app.use('/api', unsubscribeRouter)
app.use('/api', inboundEmailRouter)
// Lead Engine: data subject requests (opt-out / erasure) need no login.
app.use('/api', leadGenPublicRouter)
app.use('/api', emailWebhooks)
// Public website tracking: GET /t.js and POST /api/public/track
app.use(webTrackRouter)
// Public lead capture forms: POST /api/public/forms/:formKey/submit
app.use(formPublicRouter)

// Protected: require valid JWT
app.use('/api', authMiddleware, campaignRouter)
// CRM step 5: /api/tags and /api/campaigns/:id/tags/:tagId (CRM plan check inside the router, per route)
app.use('/api', authMiddleware, crmTagsRouter)
app.use('/api', authMiddleware, settingsRouter)
app.use('/api', authMiddleware, userRouter)
app.use('/api', authMiddleware, scriptRouter)
// CRM: plan-gated by plans.crm_enabled. Mounted on /api/crm only, so its plan check never runs for other routes.
app.use('/api/crm', authMiddleware, requirePlanFeature('crmEnabled'), crmRouter)
// Lead Engine: LEADGEN_ENABLED switch (off = 404) + plans.lead_gen_enabled. Mounted on /api/lead-gen only.
app.use('/api/lead-gen', authMiddleware, requireLeadGen, leadGenRouter)
// Inbox / Replies: plan-gated to Standard and Premium
app.use('/api', authMiddleware, requirePlanFeature('inboxEnabled'), repliesRouter)
// Follow-ups: plan-gated to Standard and Premium
app.use('/api', authMiddleware, requirePlanFeature('followUpEnabled'), followUpRouter)
app.use('/api', adminRouter)
app.use('/api', leadGenAdminRouter)
if (isDev) app.use('/api', authMiddleware, devRouter)

const router = Router()

router.get("/health", (req: Request, res: Response) => {
    res.status(200).send("Health point. The server is running correctly")
})

app.use('/api', router)

// F-13: unknown API routes answer 404 JSON (not Express's HTML page). Unknown routes under the
// protected mounts still answer 401 to logged-out callers, so route names are not revealed to them.
app.use('/api', (req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' })
})

// Malformed JSON bodies and other unhandled errors: JSON instead of an HTML error page.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err)
    const e = err as { type?: string; status?: number; statusCode?: number }
    const status = e?.status ?? e?.statusCode ?? 500
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' })
    if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' })
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'Bad request' })
    console.error('Unhandled error:', err)
    res.status(500).json({ error: 'Server error' })
})

seedInitialSuperAdmin().catch((err) => console.error('Seed super admin error:', err))

if (process.env.ENABLE_IN_PROCESS_CRM_WORKER === 'true' || (process.env.NODE_ENV === 'production' && process.env.DISABLE_CRM_WORKER !== 'true')) {
  import('./workers/crmWorker.js')
    .then((m) => m.startCrmWorker())
    .catch((err) => console.error('[CRM Worker in-process] failed to start:', err));
}

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});

// N-17: delete refresh tokens that expired more than 30 days ago (once at start, then daily).
const purgeSessions = () =>
    purgeExpiredSessions()
        .then((n) => { if (n > 0) console.log(`[auth] Purged ${n} expired session row(s)`); })
        .catch((e) => console.error('[auth] Session purge failed:', e));
setTimeout(purgeSessions, 60_000).unref();
setInterval(purgeSessions, 24 * 60 * 60 * 1000).unref();
