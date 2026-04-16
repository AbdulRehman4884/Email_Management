import React from 'react';
import { Bot, MessageSquare, RefreshCw, Send } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, TextArea } from '../components/ui';
import {
  agentApi,
  type AgentPendingAction,
  type AgentUiMessage,
} from '../lib/api';

export function AgentChat() {
  const [messages, setMessages] = React.useState<AgentUiMessage[]>([]);
  const [sessionId, setSessionId] = React.useState<string | undefined>(undefined);
  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [pendingAction, setPendingAction] = React.useState<AgentPendingAction | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const appendMessage = React.useCallback((message: AgentUiMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const sendMessage = React.useCallback(async () => {
    const text = input.trim();
    if (!text || loading || pendingAction) return;

    setError(null);
    appendMessage({ role: 'user', content: text });
    setInput('');
    setLoading(true);

    const result = await agentApi.chat(text, sessionId);
    setLoading(false);

    if (!result.success) {
      setError(result.error);
      appendMessage({ role: 'error', content: result.error });
      return;
    }

    const payload = result.data;
    if (payload.sessionId) setSessionId(payload.sessionId);

    if (payload.approvalRequired && payload.pendingAction && payload.message) {
      setPendingAction(payload.pendingAction);
      appendMessage({ role: 'assistant', content: payload.message });
      return;
    }

    if (payload.response) {
      appendMessage({ role: 'assistant', content: payload.response });
    }
  }, [appendMessage, input, loading, pendingAction, sessionId]);

  const handleConfirm = React.useCallback(async () => {
    if (!pendingAction || loading) return;
    setError(null);
    setLoading(true);
    const result = await agentApi.confirm(pendingAction.id);
    setLoading(false);

    if (!result.success) {
      setError(result.error);
      appendMessage({ role: 'error', content: result.error });
      return;
    }

    setPendingAction(null);
    appendMessage({
      role: 'assistant',
      content: result.data.response ?? 'Action confirmed successfully.',
    });
  }, [appendMessage, loading, pendingAction]);

  const handleCancel = React.useCallback(async () => {
    if (!pendingAction || loading) return;
    setError(null);
    setLoading(true);
    const result = await agentApi.cancel(pendingAction.id);
    setLoading(false);

    if (!result.success) {
      setError(result.error);
      appendMessage({ role: 'error', content: result.error });
      return;
    }

    setPendingAction(null);
    appendMessage({
      role: 'assistant',
      content: result.data.message ?? 'Action cancelled.',
    });
  }, [appendMessage, loading, pendingAction]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Agent</h1>
          <p className="text-gray-500 mt-1">
            Campaign assistant for stats, inbox, and campaign actions.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            setMessages([]);
            setSessionId(undefined);
            setPendingAction(null);
            setError(null);
          }}
          leftIcon={<RefreshCw className="w-4 h-4" />}
        >
          New chat
        </Button>
      </div>

      <Card>
        <CardHeader className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-gray-700" />
          <span className="font-semibold text-gray-900">Chat</span>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="h-[420px] overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
            {messages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-gray-500 text-sm">
                <div className="text-center">
                  <MessageSquare className="w-8 h-8 mx-auto mb-2 text-gray-400" />
                  Start by asking: "show my campaign stats"
                </div>
              </div>
            ) : (
              messages.map((msg, idx) => (
                <div
                  key={`${msg.role}-${idx}`}
                  className={`flex ${
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-gray-900 text-white'
                        : msg.role === 'error'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-white border border-gray-200 text-gray-800'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))
            )}
          </div>

          {pendingAction && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm text-amber-900 font-medium">
                Confirmation required for: {pendingAction.toolName}
              </p>
              <p className="text-xs text-amber-800 mt-1">
                This action expires at {new Date(pendingAction.expiresAt).toLocaleString()}.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={handleConfirm} isLoading={loading}>
                  Confirm
                </Button>
                <Button size="sm" variant="secondary" onClick={handleCancel} disabled={loading}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your request for the AI agent..."
                rows={3}
                disabled={loading || !!pendingAction}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
              />
            </div>
            <Button
              onClick={() => void sendMessage()}
              isLoading={loading}
              disabled={!input.trim() || !!pendingAction}
              leftIcon={<Send className="w-4 h-4" />}
            >
              Send
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
