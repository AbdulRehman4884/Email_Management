import { Router } from 'express';
import { formScriptHandler, hostedFormHandler, submitFormHandler } from '../controllers/formPublicController.js';

const router = Router();
router.get('/f.js', formScriptHandler);
router.get('/f/:formKey', hostedFormHandler);
router.post('/api/public/forms/:formKey/submit', submitFormHandler);
export default router;
