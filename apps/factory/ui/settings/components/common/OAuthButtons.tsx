import { useState } from 'react';
import { ExternalLink } from 'lucide-react';

interface OAuthButtonsProps {
  availableSources: {
    linear: boolean;
    github: boolean;
  };
  onConnectLinear: () => void;
  onConnectGitHub: () => void;
}

export function OAuthButtons({ availableSources, onConnectLinear, onConnectGitHub }: OAuthButtonsProps) {
  return (
    <div className="flex gap-2">
      {availableSources.linear && (
        <button
          onClick={onConnectLinear}
          className="px-3 py-1.5 text-sm text-gray-700 hover:text-gray-500 hover:bg-gray-100 rounded-lg"
        >
          Connect Linear
        </button>
      )}

      {availableSources.github && (
        <button
          onClick={onConnectGitHub}
          className="px-3 py-1.5 text-sm text-gray-700 hover:text-gray-500 hover:bg-gray-100 rounded-lg"
        >
          Connect GitHub
        </button>
      )}
    </div>
  );
}
