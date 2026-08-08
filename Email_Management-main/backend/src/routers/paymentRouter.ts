import { Router } from 'express';
import {
  createCheckoutSession,
  stripeWebhook,
  getCheckoutStatus,
  createCustomerPortalSession,
  getPlans,
} from '../controllers/paymentController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const paymentRouter = Router();

// Public endpoints
paymentRouter.get('/plans', getPlans);
paymentRouter.post('/payment/checkout', createCheckoutSession);
paymentRouter.get('/payment/checkout-status', getCheckoutStatus);

// Stripe webhook — raw body parsed in index.ts before this router
paymentRouter.post('/payment/webhook', stripeWebhook);

// Auth-required: Stripe customer portal
paymentRouter.post('/payment/customer-portal', authMiddleware, createCustomerPortalSession);

export default paymentRouter;
