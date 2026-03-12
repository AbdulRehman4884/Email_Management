import 'dotenv/config'
import express from 'express'
import cors from 'cors'
const app = express()
import type { Request, Response } from 'express'
import { Router } from 'express'
import campaignRouter from './routers/campaignRouter.js'
import settingsRouter from './routers/settingsRouter.js'
import trackRouter from './routers/trackRouter.js'
import unsubscribeRouter from './routers/unsubscribeRouter.js'
import emailWebhooks from './webhooks/emailWebhooks.js'
import inboundEmailRouter from './routers/inboundEmailRouter.js'
import repliesRouter from './routers/repliesRouter.js'
import devRouter from './routers/devRouter.js'

const isDev = process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_ROUTES === 'true'

// Enable CORS for frontend
app.use(cors({
    origin: ['http://localhost:3001', 'http://localhost:5173', 'http://localhost:3000', 'http://localhost:3002'],
    credentials: true
}))

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use('/api', campaignRouter)
app.use('/api', settingsRouter)
app.use('/api', trackRouter)
app.use('/api', unsubscribeRouter)
app.use('/api', inboundEmailRouter)
app.use('/api', repliesRouter)
if (isDev) app.use('/api', devRouter)
app.use('/api', emailWebhooks)

const router = Router()

router.get("/health", (req: Request, res: Response) => {
    res.status(200).send("Health point. The server is running correctly")
})

app.use('/api', router)
app.listen(3000, () => {
    console.log('Server is running on port 3000');
});




