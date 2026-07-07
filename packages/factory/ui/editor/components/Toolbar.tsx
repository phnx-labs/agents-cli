import { useState } from 'react';
import { FileDown } from 'lucide-react';

interface ToolbarProps {
  onExportPdf: () => void;
  exportError?: string | null;
  exporting?: boolean;
}

function Toolbar({ onExportPdf, exportError, exporting }: ToolbarProps) {
  const [hover, setHover] = useState(false);
  const label = exporting ? 'Converting…' : 'Convert to PDF';
  return (
    <div className="notion-toolbar">
      <button
        type="button"
        className="notion-toolbar-button"
        onClick={onExportPdf}
        disabled={exporting}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={hover ? 'Render this document to PDF and open it' : ''}
      >
        <FileDown size={14} />
        <span>{label}</span>
      </button>
      {exportError && <span className="notion-toolbar-error">{exportError}</span>}
    </div>
  );
}

export default Toolbar;
