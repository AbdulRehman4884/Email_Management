import express, { Router } from 'express';
import { trackingScriptHandler, trackPageviewHandler } from '../controllers/webTrackController.js';

const router = Router();
router.get('/t.js', trackingScriptHandler);
router.post('/api/public/track', express.text({ type: 'text/plain', limit: '8kb' }), trackPageviewHandler);
export default router;
