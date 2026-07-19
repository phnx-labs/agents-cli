import { describe, test, expect } from 'bun:test';
import {
  parseTerminalName,
  sanitizeLabel,
  getExpandedAgentName,
  getIconFilename,
  getPrefixFromIconFilename,
  getTerminalDisplayInfo,
  findTerminalNameByTabLabel,
  formatTerminalTitle,
  paneBorderText,
  PANE_BORDER_LABEL_MAX,
  getSessionChunk,
  extractFirstNWords,
  extractLinearTicketId,
  getPrefixFromTerminalId,
  mergeMcpConfig,
  createSwarmServerConfig,
  sortPrompts,
  isBuiltInPromptId,
  truncateText,
  canonicalToConfigPrefix,
  configToCanonicalPrefix,
  prefixToAgentType,
  CLAUDE_TITLE,
  CODEX_TITLE,
  GEMINI_TITLE,
  OPENCODE_TITLE,
  CURSOR_TITLE,
  SHELL_TITLE,
  KIMI_TITLE,
  DROID_TITLE
} from './utils';

describe('parseTerminalName', () => {
  test('identifies exact agent prefixes', () => {
    expect(parseTerminalName('CC')).toEqual({ isAgent: true, prefix: 'CC', label: null, sessionChunk: null });
    expect(parseTerminalName('CX')).toEqual({ isAgent: true, prefix: 'CX', label: null, sessionChunk: null });
    expect(parseTerminalName('GX')).toEqual({ isAgent: true, prefix: 'GX', label: null, sessionChunk: null });
    expect(parseTerminalName('OC')).toEqual({ isAgent: true, prefix: 'OC', label: null, sessionChunk: null });
    expect(parseTerminalName('CR')).toEqual({ isAgent: true, prefix: 'CR', label: null, sessionChunk: null });
    expect(parseTerminalName('SH')).toEqual({ isAgent: true, prefix: 'SH', label: null, sessionChunk: null });
  });

  test('accepts full agent names', () => {
    expect(parseTerminalName('Claude')).toEqual({ isAgent: true, prefix: 'CC', label: null, sessionChunk: null });
    expect(parseTerminalName('Codex')).toEqual({ isAgent: true, prefix: 'CX', label: null, sessionChunk: null });
    expect(parseTerminalName('Gemini')).toEqual({ isAgent: true, prefix: 'GX', label: null, sessionChunk: null });
    expect(parseTerminalName('OpenCode')).toEqual({ isAgent: true, prefix: 'OC', label: null, sessionChunk: null });
    expect(parseTerminalName('Cursor')).toEqual({ isAgent: true, prefix: 'CR', label: null, sessionChunk: null });
  });

  test('accepts full agent names with labels', () => {
    expect(parseTerminalName('Cursor - auth')).toEqual({
      isAgent: true,
      prefix: 'CR',
      label: 'auth',
      sessionChunk: null
    });
    expect(parseTerminalName('Claude - feature work')).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: 'feature work',
      sessionChunk: null
    });
  });

  test('identifies agent prefixes with labels', () => {
    expect(parseTerminalName('CC - auth feature')).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: 'auth feature',
      sessionChunk: null
    });
    expect(parseTerminalName('CX - bug fix')).toEqual({
      isAgent: true,
      prefix: 'CX',
      label: 'bug fix',
      sessionChunk: null
    });
  });

  test('handles whitespace correctly', () => {
    expect(parseTerminalName('  CC  ')).toEqual({ isAgent: true, prefix: 'CC', label: null, sessionChunk: null });
    expect(parseTerminalName('CC - label with spaces  ')).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: 'label with spaces',
      sessionChunk: null
    });
  });

  test('rejects non-agent terminals', () => {
    expect(parseTerminalName('bash')).toEqual({ isAgent: false, prefix: null, label: null, sessionChunk: null });
    expect(parseTerminalName('zsh')).toEqual({ isAgent: false, prefix: null, label: null, sessionChunk: null });
    expect(parseTerminalName('node')).toEqual({ isAgent: false, prefix: null, label: null, sessionChunk: null });
  });

  test('rejects partial matches (strict mode)', () => {
    // Should NOT match "cc" in lowercase
    expect(parseTerminalName('cc')).toEqual({ isAgent: false, prefix: null, label: null, sessionChunk: null });
    // Should NOT match if prefix is part of larger word
    expect(parseTerminalName('success')).toEqual({ isAgent: false, prefix: null, label: null, sessionChunk: null });
    expect(parseTerminalName('CCTools')).toEqual({ isAgent: false, prefix: null, label: null, sessionChunk: null });
    // Should NOT match without proper separator
    expect(parseTerminalName('CC-label')).toEqual({ isAgent: false, prefix: null, label: null, sessionChunk: null });
    expect(parseTerminalName('CClabel')).toEqual({ isAgent: false, prefix: null, label: null, sessionChunk: null });
  });

  test('handles empty label after separator', () => {
    // "CC - " with empty trailing content is not a valid agent name pattern
    expect(parseTerminalName('CC - ')).toEqual({ isAgent: false, prefix: null, label: null, sessionChunk: null });
  });

  test('parses session chunk formats', () => {
    expect(parseTerminalName('CC a1b2c3d4')).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: null,
      sessionChunk: 'a1b2c3d4'
    });
    expect(parseTerminalName('Claude a1b2c3d4 - task')).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: 'task',
      sessionChunk: 'a1b2c3d4'
    });
  });
});

describe('sanitizeLabel', () => {
  test('removes quotes from input', () => {
    expect(sanitizeLabel('"auth feature"')).toBe('auth feature');
    expect(sanitizeLabel("'bug fix'")).toBe('bug fix');
    expect(sanitizeLabel('`code review`')).toBe('code review');
  });

  test('limits to max 5 words', () => {
    expect(sanitizeLabel('one two three four five six seven')).toBe('one two three four five');
  });

  test('handles empty and whitespace input', () => {
    expect(sanitizeLabel('')).toBe('');
    expect(sanitizeLabel('   ')).toBe('');
    expect(sanitizeLabel('  \t\n  ')).toBe('');
  });

  test('normalizes multiple spaces', () => {
    expect(sanitizeLabel('auth    feature')).toBe('auth feature');
  });
});

describe('getSessionChunk', () => {
  test('returns first 8 characters of a UUID', () => {
    expect(getSessionChunk('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('a1b2c3d4');
  });

  test('returns null for undefined or invalid values', () => {
    expect(getSessionChunk(undefined)).toBeNull();
    expect(getSessionChunk('invalid')).toBeNull();
  });
});

describe('extractFirstNWords', () => {
  test('extracts first N words from text', () => {
    expect(extractFirstNWords('Hello world how are you doing today', 5)).toBe('Hello world how are you...');
    expect(extractFirstNWords('Hello world how are you', 5)).toBe('Hello world how are you');
    expect(extractFirstNWords('One two three', 5)).toBe('One two three');
  });

  test('adds ellipsis when truncated', () => {
    expect(extractFirstNWords('one two three four five six', 5)).toBe('one two three four five...');
    expect(extractFirstNWords('one two three four five', 5)).toBe('one two three four five');
  });

  test('handles edge cases', () => {
    expect(extractFirstNWords(undefined, 5)).toBeNull();
    expect(extractFirstNWords('', 5)).toBeNull();
    expect(extractFirstNWords('   ', 5)).toBeNull();
  });

  test('normalizes whitespace', () => {
    expect(extractFirstNWords('hello   world', 5)).toBe('hello world');
    expect(extractFirstNWords('  hello  world  ', 5)).toBe('hello world');
  });

  test('works with different N values', () => {
    expect(extractFirstNWords('one two three four five', 3)).toBe('one two three...');
    expect(extractFirstNWords('one two', 3)).toBe('one two');
  });
});

describe('extractLinearTicketId', () => {
  test('extracts Linear ticket from anywhere in text', () => {
    expect(extractLinearTicketId('Ship launchctl fix\n\nReference: RUSH-545')).toBe('RUSH-545');
    expect(extractLinearTicketId('ENG-42 is the task')).toBe('ENG-42');
    expect(extractLinearTicketId('work on ABC123-7 please')).toBe('ABC123-7');
  });

  test('returns null when no ticket present', () => {
    expect(extractLinearTicketId('just a regular message')).toBeNull();
    expect(extractLinearTicketId('')).toBeNull();
    expect(extractLinearTicketId(undefined)).toBeNull();
  });

  test('rejects lowercase and malformed ids', () => {
    expect(extractLinearTicketId('rush-545')).toBeNull();
    expect(extractLinearTicketId('RUSH545')).toBeNull();
    expect(extractLinearTicketId('RUSH-')).toBeNull();
  });

  test('returns first match when multiple present', () => {
    expect(extractLinearTicketId('blocked by RUSH-100 and RUSH-200')).toBe('RUSH-100');
  });
});

describe('getExpandedAgentName', () => {
  test('expands known prefixes', () => {
    expect(getExpandedAgentName(CLAUDE_TITLE)).toBe('Claude');
    expect(getExpandedAgentName(CODEX_TITLE)).toBe('Codex');
    expect(getExpandedAgentName(GEMINI_TITLE)).toBe('Gemini');
    expect(getExpandedAgentName(OPENCODE_TITLE)).toBe('OpenCode');
    expect(getExpandedAgentName(CURSOR_TITLE)).toBe('Cursor');
    expect(getExpandedAgentName(SHELL_TITLE)).toBe('Shell');
  });

  test('returns prefix as-is for unknown values', () => {
    expect(getExpandedAgentName('XX')).toBe('XX');
    expect(getExpandedAgentName('Custom')).toBe('Custom');
  });
});

describe('getIconFilename', () => {
  test('returns correct icon filenames', () => {
    expect(getIconFilename(CLAUDE_TITLE)).toBe('claude.png');
    expect(getIconFilename(CODEX_TITLE)).toBe('chatgpt.png');
    expect(getIconFilename(GEMINI_TITLE)).toBe('gemini.png');
    expect(getIconFilename(OPENCODE_TITLE)).toBe('opencode.png');
    expect(getIconFilename(CURSOR_TITLE)).toBe('cursor.png');
    expect(getIconFilename(SHELL_TITLE)).toBe('agents.png');
    expect(getIconFilename(KIMI_TITLE)).toBe('kimi.png');
    expect(getIconFilename(DROID_TITLE)).toBe('droid.png');
  });

  test('returns null for unknown prefixes', () => {
    expect(getIconFilename('XX')).toBeNull();
    expect(getIconFilename('Custom')).toBeNull();
  });
});

describe('getIconFilename reverse lookup', () => {
  test('getPrefixFromIconFilename returns correct prefix', () => {
    expect(getPrefixFromIconFilename('claude.png')).toBe('CC');
    expect(getPrefixFromIconFilename('chatgpt.png')).toBe('CX');
    expect(getPrefixFromIconFilename('gemini.png')).toBe('GX');
    expect(getPrefixFromIconFilename('opencode.png')).toBe('OC');
    expect(getPrefixFromIconFilename('cursor.png')).toBe('CR');
    expect(getPrefixFromIconFilename('agents.png')).toBe('SH');
    expect(getPrefixFromIconFilename('kimi.png')).toBe('KM');
    expect(getPrefixFromIconFilename('droid.png')).toBe('DR');
  });

  test('getPrefixFromIconFilename returns null for unknown icons', () => {
    expect(getPrefixFromIconFilename('unknown.png')).toBeNull();
    expect(getPrefixFromIconFilename('')).toBeNull();
  });
});

describe('getTerminalDisplayInfo', () => {
  test('Strategy 1: identifies by name parsing', () => {
    expect(getTerminalDisplayInfo({ name: 'CC' })).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: null,
      expandedName: 'Claude',
      statusBarText: 'Claude',
      iconFilename: 'claude.png',
      sessionChunk: null
    });
    expect(getTerminalDisplayInfo({ name: 'CX' })).toEqual({
      isAgent: true,
      prefix: 'CX',
      label: null,
      expandedName: 'Codex',
      statusBarText: 'Codex',
      iconFilename: 'chatgpt.png',
      sessionChunk: null
    });
    expect(getTerminalDisplayInfo({ name: 'CC - auth feature' })).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: 'auth feature',
      expandedName: 'Claude',
      statusBarText: 'Claude - auth feature',
      iconFilename: 'claude.png',
      sessionChunk: null
    });
  });

  test('Strategy 2: identifies by terminalId when name parsing fails', () => {
    expect(getTerminalDisplayInfo({ name: 'auth feature', terminalId: 'CC-1735824000000-1' })).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: 'auth feature',
      expandedName: 'Claude',
      statusBarText: 'Claude - auth feature',
      iconFilename: 'claude.png',
      sessionChunk: null
    });
  });

  test('Strategy 3: identifies by iconFilename when other strategies fail', () => {
    expect(getTerminalDisplayInfo({ name: 'auth feature', iconFilename: 'claude.png' })).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: 'auth feature',
      expandedName: 'Claude',
      statusBarText: 'Claude - auth feature',
      iconFilename: 'claude.png',
      sessionChunk: null
    });
  });

  test('priority: name parsing wins over terminalId and iconFilename', () => {
    // Even with conflicting terminalId/iconFilename, name parsing takes precedence
    const result = getTerminalDisplayInfo({
      name: 'CC - explicit label',
      terminalId: 'CX-123', // Would suggest Codex
      iconFilename: 'gemini.png' // Would suggest Gemini
    });
    expect(result.prefix).toBe('CC');
    expect(result.label).toBe('explicit label');
  });

  test('priority: terminalId wins over iconFilename', () => {
    const result = getTerminalDisplayInfo({
      name: 'my task',
      terminalId: 'CX-123',
      iconFilename: 'gemini.png'
    });
    expect(result.prefix).toBe('CX');
    expect(result.label).toBe('my task');
  });

  test('returns null fields for non-agent terminals', () => {
    expect(getTerminalDisplayInfo({ name: 'bash' })).toEqual({
      isAgent: false,
      prefix: null,
      label: null,
      expandedName: null,
      statusBarText: null,
      iconFilename: null,
      sessionChunk: null
    });
  });

  test('handles whitespace in terminal names', () => {
    expect(getTerminalDisplayInfo({ name: '  CC  ' })).toEqual({
      isAgent: true,
      prefix: 'CC',
      label: null,
      expandedName: 'Claude',
      statusBarText: 'Claude',
      iconFilename: 'claude.png',
      sessionChunk: null
    });
  });

  test('treats empty name as no label when identified by other means', () => {
    const result = getTerminalDisplayInfo({ name: '', terminalId: 'CC-123' });
    expect(result.isAgent).toBe(true);
    expect(result.prefix).toBe('CC');
    expect(result.label).toBeNull();
  });
});

describe('getPrefixFromTerminalId', () => {
  test('extracts prefix from valid ID', () => {
    expect(getPrefixFromTerminalId('CC-1735824000000-1')).toBe('CC');
    expect(getPrefixFromTerminalId('CX-123-456')).toBe('CX');
  });

  test('backward compatibility: maps old CL prefix to CC', () => {
    expect(getPrefixFromTerminalId('CL-1735824000000-1')).toBe('CC');
  });

  test('returns the ID itself if no dashes', () => {
    expect(getPrefixFromTerminalId('Claude')).toBe('Claude');
  });

  test('handles empty input', () => {
    expect(getPrefixFromTerminalId('')).toBeNull();
  });
});

describe('createSwarmServerConfig', () => {
  test('creates correct server config for given path', () => {
    const config = createSwarmServerConfig('/path/to/cli-ts/dist/index.js');
    expect(config).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/path/to/cli-ts/dist/index.js'],
      env: {}
    });
  });
});

describe('mergeMcpConfig', () => {
  test('creates new config when existing is null', () => {
    const serverConfig = createSwarmServerConfig('/path/to/index.js');
    const result = mergeMcpConfig(null, 'swarm', serverConfig);

    expect(result).toEqual({
      mcpServers: {
        swarm: {
          type: 'stdio',
          command: 'node',
          args: ['/path/to/index.js'],
          env: {}
        }
      }
    });
  });

  test('creates mcpServers when existing config has none', () => {
    const serverConfig = createSwarmServerConfig('/path/to/index.js');
    const result = mergeMcpConfig({}, 'swarm', serverConfig);

    expect(result.mcpServers).toBeDefined();
    expect(result.mcpServers!['swarm']).toEqual(serverConfig);
  });

  test('preserves existing servers when adding new one', () => {
    const existing = {
      mcpServers: {
        'other-server': {
          type: 'stdio',
          command: 'python',
          args: ['server.py'],
          env: { FOO: 'bar' }
        }
      }
    };
    const serverConfig = createSwarmServerConfig('/path/to/index.js');
    const result = mergeMcpConfig(existing, 'swarm', serverConfig);

    expect(result.mcpServers!['other-server']).toEqual(existing.mcpServers['other-server']);
    expect(result.mcpServers!['swarm']).toEqual(serverConfig);
  });

  test('overwrites existing server with same name', () => {
    const existing = {
      mcpServers: {
        swarm: {
          type: 'stdio',
          command: 'old-node',
          args: ['/old/path'],
          env: {}
        }
      }
    };
    const newConfig = createSwarmServerConfig('/new/path/index.js');
    const result = mergeMcpConfig(existing, 'swarm', newConfig);

    expect(result.mcpServers!['swarm'].args).toEqual(['/new/path/index.js']);
  });
});

describe('findTerminalNameByTabLabel', () => {
  test('finds exact match for agent terminal', () => {
    const terminalNames = ['CC', 'CX', 'GX', 'bash'];
    expect(findTerminalNameByTabLabel(terminalNames, 'CC')).toBe('CC');
    expect(findTerminalNameByTabLabel(terminalNames, 'CX')).toBe('CX');
    expect(findTerminalNameByTabLabel(terminalNames, 'GX')).toBe('GX');
  });

  test('finds terminal with label in name', () => {
    const terminalNames = ['CC', 'CC - auth feature', 'CX - bug fix'];
    expect(findTerminalNameByTabLabel(terminalNames, 'CC - auth feature')).toBe('CC - auth feature');
    expect(findTerminalNameByTabLabel(terminalNames, 'CX - bug fix')).toBe('CX - bug fix');
  });

  test('returns null when no match found', () => {
    const terminalNames = ['CC', 'CX', 'GX'];
    expect(findTerminalNameByTabLabel(terminalNames, 'bash')).toBeNull();
    expect(findTerminalNameByTabLabel(terminalNames, 'CR')).toBeNull();
    expect(findTerminalNameByTabLabel(terminalNames, 'CC - nonexistent')).toBeNull();
  });

  test('is ambiguous across duplicate names — always the first (motivates identity resolution)', () => {
    const names = ['CC', 'CC', 'CC'];
    expect(findTerminalNameByTabLabel(names, 'CC')).toBe('CC');
    // A caller doing `names.indexOf(result)` gets 0 no matter which tab is live.
    expect(names.indexOf(findTerminalNameByTabLabel(names, 'CC') as string)).toBe(0);
  });

  test('returns null for empty terminal list', () => {
    expect(findTerminalNameByTabLabel([], 'CC')).toBeNull();
  });

  test('handles multiple terminals with same base prefix', () => {
    // Simulates having multiple Claude terminals open
    const terminalNames = ['CC', 'CC', 'CC - task 1', 'CC - task 2'];
    // Should find first exact match
    expect(findTerminalNameByTabLabel(terminalNames, 'CC')).toBe('CC');
    expect(findTerminalNameByTabLabel(terminalNames, 'CC - task 1')).toBe('CC - task 1');
    expect(findTerminalNameByTabLabel(terminalNames, 'CC - task 2')).toBe('CC - task 2');
  });

  test('matches are case-sensitive', () => {
    const terminalNames = ['CC', 'Cc', 'cc'];
    expect(findTerminalNameByTabLabel(terminalNames, 'CC')).toBe('CC');
    expect(findTerminalNameByTabLabel(terminalNames, 'Cc')).toBe('Cc');
    expect(findTerminalNameByTabLabel(terminalNames, 'cc')).toBe('cc');
    expect(findTerminalNameByTabLabel(terminalNames, 'cC')).toBeNull();
  });

  test('does not match partial strings', () => {
    const terminalNames = ['CC - auth feature'];
    expect(findTerminalNameByTabLabel(terminalNames, 'CC')).toBeNull();
    expect(findTerminalNameByTabLabel(terminalNames, 'CC - auth')).toBeNull();
    expect(findTerminalNameByTabLabel(terminalNames, 'auth feature')).toBeNull();
  });
});

describe('formatTerminalTitle', () => {
  test('uses short code when showFullAgentNames is false', () => {
    expect(formatTerminalTitle('CX', {
      display: { showFullAgentNames: false, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: false }
    })).toBe('CX');
  });

  test('uses full name when showFullAgentNames is true', () => {
    expect(formatTerminalTitle('CX', {
      display: { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: false }
    })).toBe('Codex');
  });

  test('appends label with dash when labelReplacesTitle is false (default)', () => {
    expect(formatTerminalTitle('CR', {
      label: 'auth',
      display: { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: false }
    }))
      .toBe('Cursor - auth');
  });

  test('replaces title with label when labelReplacesTitle is true', () => {
    expect(formatTerminalTitle('CR', {
      label: 'auth',
      display: { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: true }
    }))
      .toBe('auth');
  });

  test('omits label when showLabelsInTitles is false', () => {
    expect(formatTerminalTitle('CR', {
      label: 'auth',
      display: { showFullAgentNames: true, showLabelsInTitles: false, showSessionIdInTitles: false, labelReplacesTitle: false }
    }))
      .toBe('Cursor');
  });

  test('includes session chunk when enabled', () => {
    expect(formatTerminalTitle('CC', {
      display: { showFullAgentNames: false, showLabelsInTitles: false, showSessionIdInTitles: true, labelReplacesTitle: false },
      sessionChunk: 'a1b2c3d4'
    })).toBe('CC a1b2c3d4');
  });

  test('includes session chunk and label when enabled', () => {
    expect(formatTerminalTitle('CC', {
      label: 'my-label',
      display: { showFullAgentNames: false, showLabelsInTitles: true, showSessionIdInTitles: true, labelReplacesTitle: false },
      sessionChunk: 'a1b2c3d4'
    })).toBe('CC a1b2c3d4 - my-label');
  });

  test('hides label when isFocused=false and showLabelOnlyOnFocus is true', () => {
    expect(formatTerminalTitle('CC', {
      label: 'auth-feature',
      display: { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: false, showLabelOnlyOnFocus: true },
      isFocused: false
    })).toBe('Claude');
  });

  test('shows label when isFocused=true and showLabelOnlyOnFocus is true', () => {
    expect(formatTerminalTitle('CC', {
      label: 'auth-feature',
      display: { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: false, showLabelOnlyOnFocus: true },
      isFocused: true
    })).toBe('Claude - auth-feature');
  });

  test('shows label when isFocused is undefined (legacy behavior)', () => {
    expect(formatTerminalTitle('CC', {
      label: 'auth-feature',
      display: { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: false, showLabelOnlyOnFocus: true }
    })).toBe('Claude - auth-feature');
  });

  test('hides label when isFocused=false with session chunk and showLabelOnlyOnFocus enabled', () => {
    expect(formatTerminalTitle('CC', {
      label: 'auth-feature',
      display: { showFullAgentNames: false, showLabelsInTitles: true, showSessionIdInTitles: true, labelReplacesTitle: false, showLabelOnlyOnFocus: true },
      sessionChunk: 'a1b2c3d4',
      isFocused: false
    })).toBe('CC a1b2c3d4');
  });

  test('shows label when isFocused=true with session chunk and showLabelOnlyOnFocus enabled', () => {
    expect(formatTerminalTitle('CC', {
      label: 'auth-feature',
      display: { showFullAgentNames: false, showLabelsInTitles: true, showSessionIdInTitles: true, labelReplacesTitle: false, showLabelOnlyOnFocus: true },
      sessionChunk: 'a1b2c3d4',
      isFocused: true
    })).toBe('CC a1b2c3d4 - auth-feature');
  });

  test('ignores isFocused when showLabelOnlyOnFocus is false', () => {
    expect(formatTerminalTitle('CC', {
      label: 'auth-feature',
      display: { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: false, showLabelOnlyOnFocus: false },
      isFocused: false
    })).toBe('Claude - auth-feature');
  });

  test('respects labelReplacesTitle when focused with showLabelOnlyOnFocus', () => {
    expect(formatTerminalTitle('CC', {
      label: 'auth-feature',
      display: { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: true, showLabelOnlyOnFocus: true },
      isFocused: true
    })).toBe('auth-feature');
  });

  test('shows base name when not focused with labelReplacesTitle and showLabelOnlyOnFocus', () => {
    expect(formatTerminalTitle('CC', {
      label: 'auth-feature',
      display: { showFullAgentNames: true, showLabelsInTitles: true, showSessionIdInTitles: false, labelReplacesTitle: true, showLabelOnlyOnFocus: true },
      isFocused: false
    })).toBe('Claude');
  });
});

describe('paneBorderText', () => {
  test('returns the bare agent code when there is no label', () => {
    expect(paneBorderText('CC')).toBe('CC');
    expect(paneBorderText('CC', undefined)).toBe('CC');
    expect(paneBorderText('CC', null)).toBe('CC');
    expect(paneBorderText('CC', '')).toBe('CC');
    expect(paneBorderText('CC', '   ')).toBe('CC');
  });

  test('appends the resolved label like the VS Code tab', () => {
    expect(paneBorderText('CC', 'Incomplete refactor upgrades audit'))
      .toBe('CC - Incomplete refactor upgrades audit');
  });

  test('flattens newlines and collapses whitespace', () => {
    expect(paneBorderText('CX', 'fix\n the  daemon\trace')).toBe('CX - fix the daemon race');
  });

  test('strips stray markup, matching formatTerminalTitle', () => {
    expect(paneBorderText('CC', 'wire <b>the</b> label')).toBe('CC - wire the label');
  });

  test('ellipsizes labels longer than the cap', () => {
    const long = 'a'.repeat(PANE_BORDER_LABEL_MAX + 20);
    const out = paneBorderText('CC', long);
    // "CC - " + PANE_BORDER_LABEL_MAX chars (last char is the … ellipsis).
    expect(out.startsWith('CC - ')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe('CC - '.length + PANE_BORDER_LABEL_MAX);
  });

  test('does not ellipsize a label exactly at the cap', () => {
    const exact = 'b'.repeat(PANE_BORDER_LABEL_MAX);
    expect(paneBorderText('CC', exact)).toBe(`CC - ${exact}`);
  });

  test('doubles a literal # so tmux renders it instead of treating it as an escape', () => {
    // GitHub-style ref keeps its # visually via tmux ## escaping.
    expect(paneBorderText('CC', 'land PR #758')).toBe('CC - land PR ##758');
  });

  test('neutralizes a #{...} format sequence in the label (the real injection threat)', () => {
    // Without escaping, tmux would expand `#{pane_id}` inside the border.
    expect(paneBorderText('CC', 'debug #{pane_id} leak')).toBe('CC - debug ##{pane_id} leak');
  });
});

describe('prompt utilities', () => {
  describe('sortPrompts', () => {
    test('sorts favorites first', () => {
      const prompts = [
        { id: '1', isFavorite: false, accessedAt: 100 },
        { id: '2', isFavorite: true, accessedAt: 50 },
        { id: '3', isFavorite: false, accessedAt: 200 }
      ];
      const sorted = sortPrompts(prompts);
      expect(sorted[0].id).toBe('2'); // favorite first
      expect(sorted[1].id).toBe('3'); // then by accessedAt desc
      expect(sorted[2].id).toBe('1');
    });

    test('sorts by accessedAt within same favorite status', () => {
      const prompts = [
        { id: '1', isFavorite: true, accessedAt: 100 },
        { id: '2', isFavorite: true, accessedAt: 300 },
        { id: '3', isFavorite: true, accessedAt: 200 }
      ];
      const sorted = sortPrompts(prompts);
      expect(sorted[0].id).toBe('2'); // most recent first
      expect(sorted[1].id).toBe('3');
      expect(sorted[2].id).toBe('1');
    });

    test('does not mutate original array', () => {
      const prompts = [
        { id: '1', isFavorite: false, accessedAt: 100 },
        { id: '2', isFavorite: true, accessedAt: 50 }
      ];
      const sorted = sortPrompts(prompts);
      expect(prompts[0].id).toBe('1'); // original unchanged
      expect(sorted[0].id).toBe('2');
    });

    test('handles empty array', () => {
      expect(sortPrompts([])).toEqual([]);
    });
  });

  describe('isBuiltInPromptId', () => {
    test('identifies built-in prompts', () => {
      expect(isBuiltInPromptId('builtin-rethink')).toBe(true);
      expect(isBuiltInPromptId('builtin-debugit')).toBe(true);
      expect(isBuiltInPromptId('builtin-anything')).toBe(true);
    });

    test('identifies user prompts', () => {
      expect(isBuiltInPromptId('1234567890-abc123')).toBe(false);
      expect(isBuiltInPromptId('user-prompt')).toBe(false);
      expect(isBuiltInPromptId('my-builtin')).toBe(false); // must start with builtin-
    });
  });

  describe('truncateText', () => {
    test('returns text unchanged if within limit', () => {
      expect(truncateText('hello', 10)).toBe('hello');
      expect(truncateText('hello', 5)).toBe('hello');
    });

    test('truncates text with ellipsis', () => {
      expect(truncateText('hello world', 8)).toBe('hello...');
      expect(truncateText('abcdefghij', 7)).toBe('abcd...');
    });

    test('handles edge cases', () => {
      expect(truncateText('', 10)).toBe('');
      expect(truncateText('abc', 3)).toBe('abc');
      expect(truncateText('abcd', 3)).toBe('...');
    });
  });
});

describe('prefix conversion utilities', () => {
  describe('canonicalToConfigPrefix', () => {
    test('converts canonical prefixes to config prefixes', () => {
      expect(canonicalToConfigPrefix('CC')).toBe('cl');
      expect(canonicalToConfigPrefix('CX')).toBe('cx');
      expect(canonicalToConfigPrefix('GX')).toBe('gm');
      expect(canonicalToConfigPrefix('OC')).toBe('oc');
      expect(canonicalToConfigPrefix('CR')).toBe('cr');
      expect(canonicalToConfigPrefix('SH')).toBe('sh');
    });

    test('is case insensitive', () => {
      expect(canonicalToConfigPrefix('cc')).toBe('cl');
      expect(canonicalToConfigPrefix('Cc')).toBe('cl');
      expect(canonicalToConfigPrefix('gx')).toBe('gm');
    });

    test('returns null for unknown prefixes', () => {
      expect(canonicalToConfigPrefix('XX')).toBe(null);
      expect(canonicalToConfigPrefix('unknown')).toBe(null);
    });

    test('handles null input', () => {
      expect(canonicalToConfigPrefix(null)).toBe(null);
    });
  });

  describe('configToCanonicalPrefix', () => {
    test('converts config prefixes to canonical prefixes', () => {
      expect(configToCanonicalPrefix('cl')).toBe('CC');
      expect(configToCanonicalPrefix('cx')).toBe('CX');
      expect(configToCanonicalPrefix('gm')).toBe('GX');
      expect(configToCanonicalPrefix('oc')).toBe('OC');
      expect(configToCanonicalPrefix('cr')).toBe('CR');
      expect(configToCanonicalPrefix('sh')).toBe('SH');
    });

    test('is case insensitive', () => {
      expect(configToCanonicalPrefix('CL')).toBe('CC');
      expect(configToCanonicalPrefix('Cl')).toBe('CC');
      expect(configToCanonicalPrefix('GM')).toBe('GX');
    });

    test('returns null for unknown prefixes', () => {
      expect(configToCanonicalPrefix('xx')).toBe(null);
      expect(configToCanonicalPrefix('unknown')).toBe(null);
    });

    test('handles null input', () => {
      expect(configToCanonicalPrefix(null)).toBe(null);
    });
  });

  describe('prefixToAgentType', () => {
    test('converts canonical prefixes to agent types', () => {
      expect(prefixToAgentType('CC')).toBe('claude');
      expect(prefixToAgentType('CX')).toBe('codex');
      expect(prefixToAgentType('GX')).toBe('gemini');
      expect(prefixToAgentType('OC')).toBe('opencode');
      expect(prefixToAgentType('CR')).toBe('cursor');
    });

    test('converts config prefixes to agent types', () => {
      expect(prefixToAgentType('cl')).toBe('claude');
      expect(prefixToAgentType('cx')).toBe('codex');
      expect(prefixToAgentType('gm')).toBe('gemini');
      expect(prefixToAgentType('oc')).toBe('opencode');
      expect(prefixToAgentType('cr')).toBe('cursor');
    });

    test('is case insensitive', () => {
      expect(prefixToAgentType('cc')).toBe('claude');
      expect(prefixToAgentType('CC')).toBe('claude');
      expect(prefixToAgentType('Cl')).toBe('claude');
      expect(prefixToAgentType('CL')).toBe('claude');
    });

    test('returns null for shell prefix (no session support)', () => {
      expect(prefixToAgentType('SH')).toBe(null);
      expect(prefixToAgentType('sh')).toBe(null);
    });

    test('returns null for unknown prefixes', () => {
      expect(prefixToAgentType('XX')).toBe(null);
      expect(prefixToAgentType('unknown')).toBe(null);
    });

    test('handles null input', () => {
      expect(prefixToAgentType(null)).toBe(null);
    });
  });
});
