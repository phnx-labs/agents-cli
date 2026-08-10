import { useState, useEffect } from 'react';
import { postMessage } from '../../hooks';

interface ApiKeyDialogProps {
  provider: 'linear' | 'github';
  onAuthComplete: () => void;
  onClose: () => void;
}

export function ApiKeyDialog({ provider, onAuthComplete, onClose }: ApiKeyDialogProps) {
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'integrationStatus' && message.provider === provider) {
        if (message.connected) {
          setStatus('success');
          onAuthComplete();
        } else if (message.error) {
          setStatus('error');
          setErrorMessage(message.error);
        }
      }
    };

    window.addEventListener('message', handleMessage);

    if (provider === 'github') {
      postMessage({ type: 'checkGitHubAuth' });
    }

    return () => window.removeEventListener('message', handleMessage);
  }, [provider, onAuthComplete]);

  const handleSaveLinearKey = () => {
    if (!apiKey.trim()) return;
    setStatus('saving');
    postMessage({ type: 'saveLinearApiKey', key: apiKey.trim() });
  };

  const handleCheckGitHub = () => {
    setStatus('saving');
    postMessage({ type: 'checkGitHubAuth' });
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
      <div className="bg-[var(--background)] border border-[var(--border)] rounded-lg p-6 max-w-md shadow-xl">
        <h2 className="text-lg font-semibold mb-4 text-[var(--foreground)]">
          {provider === 'linear' ? 'Connect Linear' : 'Connect GitHub'}
        </h2>

        {provider === 'linear' ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted-foreground)]">
              Paste your Linear API key after running linear setup once. You can create one at linear.app/settings/api.
            </p>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="lin_api_..."
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
              onKeyDown={e => e.key === 'Enter' && handleSaveLinearKey()}
            />
            <button
              onClick={handleSaveLinearKey}
              disabled={!apiKey.trim() || status === 'saving'}
              className="px-4 py-2 text-sm bg-[var(--primary)] text-[var(--primary-foreground)] rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              {status === 'saving' ? 'Saving...' : 'Save'}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-[var(--muted-foreground)]">
              GitHub uses the gh CLI for authentication. Run this in your terminal:
            </p>
            <code className="block px-3 py-2 text-sm rounded-lg bg-[var(--muted)] text-[var(--foreground)] font-mono">
              gh auth login
            </code>
            <button
              onClick={handleCheckGitHub}
              disabled={status === 'saving'}
              className="px-4 py-2 text-sm bg-[var(--primary)] text-[var(--primary-foreground)] rounded-lg hover:opacity-90 disabled:opacity-50"
            >
              {status === 'saving' ? 'Checking...' : 'Check connection'}
            </button>
          </div>
        )}

        {status === 'success' && (
          <p className="mt-3 text-sm text-green-600">Connected</p>
        )}

        {status === 'error' && (
          <p className="mt-3 text-sm text-red-600">
            {errorMessage || 'Connection failed. Please try again.'}
          </p>
        )}

        <button
          onClick={onClose}
          className="block mt-4 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
