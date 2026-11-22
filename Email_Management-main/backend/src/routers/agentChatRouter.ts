import { Router } from 'express';
import { deleteAgentChat, getAgentChat, listAgentChats, saveAgentChat } from '../controllers/agentChatController.js';

/** AI Agent chat history (mounted at /api with authMiddleware). */
const app = Router();

app.get('/agent-chats', listAgentChats);
app.get('/agent-chats/:sessionId', getAgentChat);
app.put('/agent-chats/:sessionId', saveAgentChat);
app.delete('/agent-chats/:sessionId', deleteAgentChat);

export default app;
