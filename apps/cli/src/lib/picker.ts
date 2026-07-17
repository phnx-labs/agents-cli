/**
 * Interactive fuzzy-filter picker built on @inquirer/core.
 *
 * Provides a searchable, paginated list UI with optional preview pane
 * for selecting items in the terminal. Used by session picker, command
 * picker, and other interactive selection flows.
 */

/**
 * Custom inquirer prompt for searchable, scrollable selection lists.
 *
 * Extends @inquirer/core to support type-ahead filtering, column-aligned
 * display, and keyboard navigation. Used by sessions, teams, and other
 * interactive pickers throughout the CLI.
 */

import {
  createPrompt,
  useState,
  useKeypress,
  useEffect,
  useMemo,
  useRef,
  usePagination,
  usePrefix,
  makeTheme,
  isEnterKey,
  isUpKey,
  isDownKey,
  isSpaceKey,
  isBackspaceKey,
  Separator,
} from '@inquirer/core';
import chalk from 'chalk';
import { stripVTControlCharacters } from 'node:util';

/** Configuration for the interactive picker prompt. */
export interface PickerConfig<T> {
  message: string;
  /** Optional dim hint line rendered directly under the header (above the rows). */
  subtitle?: string;
  items: T[];
  filter: (query: string) => T[];
  labelFor: (item: T, query: string) => string;
  buildPreview?: (item: T) => string;
  shortIdFor?: (item: T) => string;
  pageSize?: number;
  initialSearch?: string;
  emptyMessage?: string;
  enterHint?: string;
}

/** The result returned when the user selects an item. */
export interface PickedItem<T> {
  item: T;
}

/** Configuration for the multi-select picker prompt. */
export interface MultiPickerConfig<T> {
  message: string;
  items: T[];
  filter: (query: string) => T[];
  labelFor: (item: T, query: string) => string;
  /** Stable identity for an item — drives the selected set. */
  keyFor: (item: T) => string;
  buildPreview?: (item: T) => string;
  pageSize?: number;
  initialSearch?: string;
  emptyMessage?: string;
  enterHint?: string;
}

interface Choice<T> {
  value: T;
  label: string;
}

const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_TERMINAL_WIDTH = 80;

function terminalWidth(): number {
  return Math.max(1, process.stdout.columns || DEFAULT_TERMINAL_WIDTH);
}

function terminalRows(): number {
  return Math.max(1, process.stdout.rows || DEFAULT_TERMINAL_ROWS);
}

function renderedRows(text: string, width: number): number {
  const normalizedWidth = Math.max(1, width);
  return text.split('\n').reduce((rows, line) => {
    const visible = stripVTControlCharacters(line).length;
    return rows + Math.max(1, Math.ceil(visible / normalizedWidth));
  }, 0);
}

function truncateAnsiLine(line: string, maxVisibleWidth: number): string {
  if (maxVisibleWidth <= 0) return '';

  const targetWidth = Math.max(0, maxVisibleWidth - 1);
  const ansiPattern = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/y;
  let out = '';
  let visible = 0;

  for (let i = 0; i < line.length;) {
    ansiPattern.lastIndex = i;
    const ansi = ansiPattern.exec(line);
    if (ansi) {
      out += ansi[0];
      i = ansiPattern.lastIndex;
      continue;
    }

    const char = line[i];
    if (visible >= targetWidth) break;
    out += char;
    visible += 1;
    i += char.length;
  }

  return out + '\x1b[0m' + chalk.gray('…');
}

function takePreviewRows(preview: string, rowBudget: number, width: number): string[] {
  const lines = preview.split('\n');
  const out: string[] = [];
  let used = 0;

  for (const line of lines) {
    const lineRows = renderedRows(line, width);
    if (used + lineRows <= rowBudget) {
      out.push(line);
      used += lineRows;
      continue;
    }

    const remainingRows = rowBudget - used;
    if (remainingRows > 0) {
      out.push(truncateAnsiLine(line, remainingRows * width));
    }
    break;
  }

  return out;
}

function previewTruncatedMarker(width: number): string {
  const full = '... preview truncated to fit terminal';
  const short = '... truncated';
  const text = full.length <= width ? full : short;
  if (text.length <= width) return chalk.gray(text);
  return chalk.gray(text.slice(0, Math.max(0, width - 1)) + '…');
}

/** Clip a picker preview so the full prompt can fit in the terminal viewport. */
export function limitPreviewHeight(preview: string, maxRows: number, width: number): string {
  const normalizedRows = Math.max(0, maxRows);
  if (normalizedRows === 0) return '';
  if (renderedRows(preview, width) <= normalizedRows) return preview;
  if (normalizedRows === 1) return previewTruncatedMarker(width);

  const lines = takePreviewRows(preview, normalizedRows - 1, width);
  lines.push(previewTruncatedMarker(width));
  return lines.join('\n');
}

/** Show an interactive fuzzy-filter picker and return the selected item, or null on cancel. */
export function itemPicker<T>(config: PickerConfig<T>): Promise<PickedItem<T> | null> {
  const prompt = createPrompt<PickedItem<T> | null, PickerConfig<T>>((cfg, done) => {
    const theme = makeTheme({});
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [searchTerm, setSearchTerm] = useState(cfg.initialSearch ?? '');
    const [previewOpen, setPreviewOpen] = useState(Boolean(cfg.buildPreview));
    const prefix = usePrefix({ status, theme });

    const results = useMemo(() => {
      const filtered = cfg.filter(searchTerm).slice(0, 50);
      return filtered.map<Choice<T>>((item) => ({
        value: item,
        label: cfg.labelFor(item, searchTerm),
      }));
    }, [searchTerm]);

    const [active, setActive] = useState(0);

    useEffect(() => {
      if (active >= results.length) setActive(0);
    }, [results]);

    const selected = results[active];

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        if (selected) {
          setStatus('done');
          done({ item: selected.value });
        }
        return;
      }

      if (isSpaceKey(key) && searchTerm === '' && cfg.buildPreview) {
        rl.clearLine(0);
        setPreviewOpen(!previewOpen);
        return;
      }

      if (isUpKey(key)) {
        rl.clearLine(0);
        if (results.length > 0) {
          setActive((active - 1 + results.length) % results.length);
        }
        return;
      }

      if (isDownKey(key)) {
        rl.clearLine(0);
        if (results.length > 0) {
          setActive((active + 1) % results.length);
        }
        return;
      }

      setSearchTerm(rl.line);
      if (previewOpen) setPreviewOpen(false);
    });

    const message = theme.style.message(cfg.message, status);

    if (status === 'done' && selected) {
      const shortId = cfg.shortIdFor ? cfg.shortIdFor(selected.value) : '';
      return `${prefix} ${message}${shortId ? ' ' + chalk.cyan(shortId) : ''}`;
    }

    const hasPreview = Boolean(cfg.buildPreview);
    const placeholder = hasPreview
      ? '(type to filter, space to hide preview)'
      : '(type to filter)';
    const searchStr = searchTerm ? chalk.cyan(searchTerm) : chalk.gray(placeholder);
    const header = [prefix, message, searchStr].filter(Boolean).join(' ');

    const page = usePagination({
      items: results as any,
      active,
      renderItem({ item, isActive }: { item: Choice<T>; isActive: boolean }) {
        if (Separator.isSeparator(item)) return ` ${(item as any).separator}`;
        const cursor = isActive ? chalk.cyan('>') : ' ';
        const row = isActive ? chalk.bold(item.label) : item.label;
        return `${cursor} ${row}`;
      },
      pageSize: cfg.pageSize ?? 10,
      loop: false,
    });

    const enter = cfg.enterHint ?? 'select';
    const help = previewOpen
      ? chalk.gray(`↑↓ navigate · space: close preview · ⏎ ${enter} · esc: cancel`)
      : chalk.gray(
          `↑↓ navigate${hasPreview ? ' · space: preview' : ''} · ⏎ ${enter} · esc: cancel`
        );

    const parts: string[] = [header];
    if (cfg.subtitle) parts.push(cfg.subtitle);
    parts.push(page);
    if (results.length === 0) {
      parts.push(chalk.gray(`  ${cfg.emptyMessage ?? 'No matches.'}`));
    }

    if (previewOpen && selected && cfg.buildPreview) {
      const width = terminalWidth();
      const separator = chalk.gray('─'.repeat(Math.min(width, 80)));
      const fixedRows =
        renderedRows(header, width) +
        renderedRows(parts.slice(1).join('\n'), width) +
        renderedRows(separator, width) +
        renderedRows(help, width);
      const availablePreviewRows = terminalRows() - fixedRows;
      const preview = limitPreviewHeight(cfg.buildPreview(selected.value), availablePreviewRows, width);
      if (preview) {
        parts.push(separator);
        parts.push(preview);
      }
    }

    parts.push(help);

    return [header, parts.slice(1).join('\n')];
  });
  return prompt(config);
}

/**
 * Multi-select variant of {@link itemPicker}. Same searchable, paginated list
 * and preview pane, but `space` toggles a checkbox on the active row instead of
 * the preview (preview moves to `tab`), and `enter` confirms every checked row.
 *
 * Returns the selected items (in the config's `items` order) or `null` on
 * cancel. Pressing `enter` with nothing checked confirms just the highlighted
 * row, so a quick single-pick still works.
 */
export function multiItemPicker<T>(config: MultiPickerConfig<T>): Promise<T[] | null> {
  const prompt = createPrompt<T[] | null, MultiPickerConfig<T>>((cfg, done) => {
    const theme = makeTheme({});
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [searchTerm, setSearchTerm] = useState(cfg.initialSearch ?? '');
    const [previewOpen, setPreviewOpen] = useState(false);
    const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
    const [active, setActive] = useState(0);
    const prefix = usePrefix({ status, theme });

    const results = useMemo(() => {
      const filtered = cfg.filter(searchTerm).slice(0, 200);
      return filtered.map<Choice<T>>((item) => ({
        value: item,
        label: cfg.labelFor(item, searchTerm),
      }));
    }, [searchTerm]);

    useEffect(() => {
      if (active >= results.length) setActive(0);
    }, [results]);

    const selected = results[active];

    // Selected items resolved in the original list order for deterministic fan-out.
    const collectSelected = (): T[] => cfg.items.filter((it) => selectedKeys.has(cfg.keyFor(it)));

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        const chosen = selectedKeys.size > 0 ? collectSelected() : selected ? [selected.value] : [];
        if (chosen.length === 0) return;
        setStatus('done');
        done(chosen);
        return;
      }

      // space toggles the active row's checkbox; strip the space from the buffer
      // so it never leaks into the filter.
      if (isSpaceKey(key)) {
        rl.clearLine(0);
        if (selected) {
          const k = cfg.keyFor(selected.value);
          const next = new Set(selectedKeys);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          setSelectedKeys(next);
        }
        return;
      }

      if (key.name === 'tab' && cfg.buildPreview) {
        rl.clearLine(0);
        setPreviewOpen(!previewOpen);
        return;
      }

      if (isUpKey(key)) {
        rl.clearLine(0);
        if (results.length > 0) setActive((active - 1 + results.length) % results.length);
        return;
      }

      if (isDownKey(key)) {
        rl.clearLine(0);
        if (results.length > 0) setActive((active + 1) % results.length);
        return;
      }

      setSearchTerm(rl.line);
    });

    const message = theme.style.message(cfg.message, status);
    const count = selectedKeys.size;

    if (status === 'done') {
      return `${prefix} ${message} ${chalk.cyan(`${count || 1} session${(count || 1) === 1 ? '' : 's'}`)}`;
    }

    const placeholder = '(type to filter · space to toggle · enter to resume)';
    const searchStr = searchTerm ? chalk.cyan(searchTerm) : chalk.gray(placeholder);
    const header = [prefix, message, searchStr].filter(Boolean).join(' ');

    const page = usePagination({
      items: results as any,
      active,
      renderItem({ item, isActive }: { item: Choice<T>; isActive: boolean }) {
        if (Separator.isSeparator(item)) return ` ${(item as any).separator}`;
        const checked = selectedKeys.has(cfg.keyFor(item.value));
        const box = checked ? chalk.green('[x]') : chalk.gray('[ ]');
        const cursor = isActive ? chalk.cyan('>') : ' ';
        const row = isActive ? chalk.bold(item.label) : item.label;
        return `${cursor} ${box} ${row}`;
      },
      pageSize: cfg.pageSize ?? 10,
      loop: false,
    });

    const enter = cfg.enterHint ?? 'resume';
    const countStr = count > 0 ? chalk.green(`${count} selected`) : chalk.gray('0 selected');
    const help = chalk.gray(
      `${countStr}${chalk.gray(' · ↑↓ navigate · space toggle')}${
        cfg.buildPreview ? chalk.gray(' · tab preview') : ''
      }${chalk.gray(` · ⏎ ${enter} · esc cancel`)}`,
    );

    const parts: string[] = [header, page];
    if (results.length === 0) {
      parts.push(chalk.gray(`  ${cfg.emptyMessage ?? 'No matches.'}`));
    }

    if (previewOpen && selected && cfg.buildPreview) {
      const width = terminalWidth();
      const separator = chalk.gray('─'.repeat(Math.min(width, 80)));
      const fixedRows =
        renderedRows(header, width) +
        renderedRows(parts.slice(1).join('\n'), width) +
        renderedRows(separator, width) +
        renderedRows(help, width);
      const availablePreviewRows = terminalRows() - fixedRows;
      const preview = limitPreviewHeight(cfg.buildPreview(selected.value), availablePreviewRows, width);
      if (preview) {
        parts.push(separator);
        parts.push(preview);
      }
    }

    parts.push(help);

    return [header, parts.slice(1).join('\n')];
  });
  return prompt(config);
}

/** Configuration for the dynamic (async-refetch) picker prompt. */
export interface DynamicPickerConfig<T, F> {
  message: string;
  /** The initial filter state. Changing it (via a keybinding) re-runs {@link load}. */
  initialFilter: F;
  /** Async loader for the current filter state. Its result is the row pool. */
  load: (filter: F) => Promise<T[]>;
  labelFor: (item: T, query: string) => string;
  /** Stable identity for an item (used for the active-row cursor across reloads). */
  keyFor: (item: T) => string;
  /** Client-side text filter over the loaded pool (the `S` search). */
  matches?: (item: T, query: string) => boolean;
  buildPreview?: (item: T) => string;
  /** Dim summary of the current filter state, rendered in the header. */
  headerFor?: (filter: F) => string;
  /** The hotkey-legend help line; receives the mode so it can adapt. */
  helpFor?: (filter: F, mode: 'nav' | 'search') => string;
  /**
   * Single-key bindings (by key name) that transform the filter. Returning the
   * SAME reference is a no-op; a new object triggers a reload.
   */
  keyBindings?: Record<string, (filter: F) => F>;
  /**
   * Side-effecting keys that don't change the filter (e.g. `y` copies a command).
   * Receives the live search `query` so the effect can be search-aware. Return a
   * short string to flash under the list.
   */
  onKey?: (name: string, filter: F, active: T | undefined, query: string) => string | void;
  /** Key that enters search mode (default `s`). */
  searchKey?: string;
  /** Key that toggles the preview pane (default `tab`). */
  previewKey?: string;
  pageSize?: number;
  emptyMessage?: string;
  loadingMessage?: string;
  enterHint?: string;
}

/** The result returned when the user selects a row: the item plus the live filter. */
export interface DynamicPicked<T, F> {
  item: T;
  filter: F;
}

/**
 * Async-refetch variant of {@link itemPicker}. Holds a `filter` object in state and
 * re-runs `load(filter)` whenever a keybinding mutates it (with a loading placeholder
 * while the fetch — e.g. an SSH fleet fan-out — is in flight). A separate `S` search
 * mode filters the loaded pool client-side. `enter` returns the active row + the live
 * filter; `esc` cancels (from search mode, `esc` first exits search).
 *
 * Same render/pagination/preview machinery as the static pickers — only the data
 * source and keymap are dynamic.
 */
export function dynamicPicker<T, F>(config: DynamicPickerConfig<T, F>): Promise<DynamicPicked<T, F> | null> {
  const prompt = createPrompt<DynamicPicked<T, F> | null, DynamicPickerConfig<T, F>>((cfg, done) => {
    const theme = makeTheme({});
    const [status, setStatus] = useState<'idle' | 'done'>('idle');
    const [filter, setFilter] = useState<F>(() => cfg.initialFilter);
    const [items, setItems] = useState<T[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState<'nav' | 'search'>('nav');
    const [previewOpen, setPreviewOpen] = useState(false);
    const [active, setActive] = useState(0);
    const [flash, setFlash] = useState('');
    const prefix = usePrefix({ status, theme });
    // Guards against a slow load resolving after a newer filter superseded it.
    const gen = useRef(0);

    useEffect(() => {
      const my = ++gen.current;
      setLoading(true);
      Promise.resolve(cfg.load(filter))
        .then((rows) => {
          if (my !== gen.current) return;
          setItems(rows);
          setLoading(false);
          setActive(0);
        })
        .catch(() => {
          if (my !== gen.current) return;
          setItems([]);
          setLoading(false);
        });
    }, [filter]);

    const results = useMemo(() => {
      const q = query.trim();
      const pool = q && cfg.matches ? items.filter((it) => cfg.matches!(it, q)) : items;
      return pool.slice(0, 200).map<Choice<T>>((item) => ({
        value: item,
        label: cfg.labelFor(item, q),
      }));
    }, [items, query]);

    useEffect(() => {
      if (active >= results.length) setActive(0);
    }, [results]);

    const selected = results[active];

    const finish = (): void => {
      if (!selected) return;
      setStatus('done');
      done({ item: selected.value, filter });
    };

    useKeypress((key, rl) => {
      if (isEnterKey(key)) {
        finish();
        return;
      }

      // Search mode: we own the query buffer (readline's line doesn't survive
      // across renders here, so we build it from key events). Clear readline
      // every keystroke so nothing leaks, then append the typed character.
      if (mode === 'search') {
        if (key.name === 'escape') {
          // Exit search but KEEP the query as an active filter, so hotkeys (and
          // the y copy-cmd) operate on the searched view. A second esc in nav
          // clears it. Enter also confirms the highlighted row directly.
          rl.clearLine(0);
          setMode('nav');
          return;
        }
        if (isUpKey(key)) {
          rl.clearLine(0);
          if (results.length > 0) setActive((active - 1 + results.length) % results.length);
          return;
        }
        if (isDownKey(key)) {
          rl.clearLine(0);
          if (results.length > 0) setActive((active + 1) % results.length);
          return;
        }
        if (isBackspaceKey(key)) {
          rl.clearLine(0);
          setQuery(query.slice(0, -1));
          return;
        }
        const seq = (key as { sequence?: string }).sequence;
        rl.clearLine(0);
        if (seq && seq.length === 1 && seq >= ' ' && !key.ctrl) {
          setQuery(query + seq);
        }
        return;
      }

      // Nav mode: single keys are hotkeys — clear the readline buffer so a hotkey
      // letter (r/b/c/…) never accumulates as stray input.
      rl.clearLine(0);
      if (key.name === 'escape') {
        // First esc clears an active search filter; a second (no filter) cancels.
        if (query) {
          setQuery('');
          return;
        }
        done(null);
        return;
      }
      if (isUpKey(key)) {
        if (results.length > 0) setActive((active - 1 + results.length) % results.length);
        return;
      }
      if (isDownKey(key)) {
        if (results.length > 0) setActive((active + 1) % results.length);
        return;
      }
      if (flash) setFlash('');
      if (key.name === (cfg.searchKey ?? 's')) {
        setMode('search');
        return;
      }
      if (cfg.buildPreview && key.name === (cfg.previewKey ?? 'tab')) {
        setPreviewOpen(!previewOpen);
        return;
      }
      const binding = cfg.keyBindings?.[key.name ?? ''];
      if (binding) {
        const next = binding(filter);
        if (!Object.is(next, filter)) setFilter(next);
        return;
      }
      if (cfg.onKey) {
        const msg = cfg.onKey(key.name ?? '', filter, selected?.value, query);
        if (msg) setFlash(msg);
      }
    });

    const message = theme.style.message(cfg.message, status);

    if (status === 'done') {
      return `${prefix} ${message}`;
    }

    const headerBits = [prefix, message];
    if (cfg.headerFor) headerBits.push(chalk.gray(cfg.headerFor(filter)));
    if (mode === 'search') {
      headerBits.push(query ? chalk.cyan('/' + query) : chalk.gray('/ (type to filter)'));
    } else if (query) {
      headerBits.push(chalk.cyan('/' + query));
    }
    const header = headerBits.filter(Boolean).join(' ');

    const page = usePagination({
      items: results as any,
      active,
      renderItem({ item, isActive }: { item: Choice<T>; isActive: boolean }) {
        if (Separator.isSeparator(item)) return ` ${(item as any).separator}`;
        const cursor = isActive ? chalk.cyan('>') : ' ';
        const row = isActive ? chalk.bold(item.label) : item.label;
        return `${cursor} ${row}`;
      },
      pageSize: cfg.pageSize ?? 12,
      loop: false,
    });

    const help = chalk.gray(
      cfg.helpFor
        ? cfg.helpFor(filter, mode)
        : mode === 'search'
          ? '↑↓ navigate · esc exit search · ⏎ ' + (cfg.enterHint ?? 'select')
          : 's search · ↑↓ navigate · ⏎ ' + (cfg.enterHint ?? 'select') + ' · esc cancel',
    );

    const parts: string[] = [header];
    if (loading) {
      parts.push(chalk.gray(`  ${cfg.loadingMessage ?? 'Loading…'}`));
    } else {
      parts.push(page);
      if (results.length === 0) {
        parts.push(chalk.gray(`  ${cfg.emptyMessage ?? 'No matches.'}`));
      }
    }

    if (previewOpen && selected && cfg.buildPreview && !loading) {
      const width = terminalWidth();
      const separator = chalk.gray('─'.repeat(Math.min(width, 80)));
      const flashRows = flash ? renderedRows(flash, width) : 0;
      const fixedRows =
        renderedRows(header, width) +
        renderedRows(parts.slice(1).join('\n'), width) +
        renderedRows(separator, width) +
        renderedRows(help, width) +
        flashRows;
      const availablePreviewRows = terminalRows() - fixedRows;
      const preview = limitPreviewHeight(cfg.buildPreview(selected.value), availablePreviewRows, width);
      if (preview) {
        parts.push(separator);
        parts.push(preview);
      }
    }

    if (flash) parts.push(chalk.green(flash));
    parts.push(help);

    return [header, parts.slice(1).join('\n')];
  });
  return prompt(config);
}
