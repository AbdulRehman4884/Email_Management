import 'dotenv/config'
import express from 'express'
import { seedInitialSuperAdmin } from './lib/seedSuperAdmin.js'
import cors from 'cors'
const app = express()
app.disable('etag')
import type { Request, Response } from 'express'
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
import { authMiddleware } from './middleware/authMiddleware.js'

const isDev = process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_ROUTES === 'true'

// Enable CORS for frontend (production origin from env or localhost for dev)
const allowedOrigins = [
    'http://localhost:3001',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:3002',
];
if (process.env.CORS_ORIGIN) {
    allowedOrigins.push(...process.env.CORS_ORIGIN.split(',').map((o) => o.trim()));
}
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
}))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Public: auth (signup, login) and tracking/unsubscribe/webhooks
app.use('/api', authRouter)
app.use('/api', trackRouter)
app.use('/api', unsubscribeRouter)
app.use('/api', inboundEmailRouter)
app.use('/api', emailWebhooks)

// Protected: require valid JWT
app.use('/api', authMiddleware, campaignRouter)
app.use('/api', authMiddleware, settingsRouter)
app.use('/api', authMiddleware, userRouter)
app.use('/api', authMiddleware, repliesRouter)
app.use('/api', authMiddleware, followUpRouter)
app.use('/api', adminRouter)
if (isDev) app.use('/api', authMiddleware, devRouter)

const router = Router()

router.get("/health", (req: Request, res: Response) => {
    res.status(200).send("Health point. The server is running correctly")
})

app.use('/api', router)

seedInitialSuperAdmin().catch((err) => console.error('Seed super admin error:', err))

app.listen(3000, () => {
    console.log('Server is running on port 3000');
});




