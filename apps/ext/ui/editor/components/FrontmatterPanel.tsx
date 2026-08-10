import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

interface FrontmatterPanelProps {
  data: Record<string, unknown>;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function FrontmatterPanel({ data }: FrontmatterPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const entries = Object.entries(data);
  if (entries.length === 0) return null;

  const fieldLabel = entries.length === 1 ? '1 metadata field' : `${entries.length} metadata fields`;

  return (
    <div className="notion-frontmatter">
      <button
        type="button"
        className="notion-frontmatter-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{fieldLabel}</span>
      </button>
      {expanded && (
        <table className="notion-frontmatter-table">
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key}>
                <td className="notion-frontmatter-key">{key}</td>
                <td className="notion-frontmatter-value">{formatValue(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default FrontmatterPanel;
