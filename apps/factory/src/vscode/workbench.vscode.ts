import * as vscode from 'vscode';

/**
 * Update multiple VS Code settings at once.
 * Keys use dot notation (e.g., 'workbench.sideBar.location').
 */
export async function updateSettings(
  settings: Record<string, unknown>,
  target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global
): Promise<void> {
  for (const [key, value] of Object.entries(settings)) {
    // Split key into section and property (e.g., 'workbench.sideBar.location' -> 'workbench', 'sideBar.location')
    const firstDot = key.indexOf('.');
    if (firstDot === -1) {
      throw new Error(`Invalid setting key: ${key}. Must include section (e.g., 'workbench.sideBar.location')`);
    }
    const section = key.slice(0, firstDot);
    const property = key.slice(firstDot + 1);

    const config = vscode.workspace.getConfiguration(section);
    await config.update(property, value, target);
  }
}

export interface EditorAssociation {
  viewType: string;
  filenamePattern: string;
}

/**
 * Read a VS Code setting value.
 */
export function getSetting<T>(key: string): T | undefined {
  const firstDot = key.indexOf('.');
  if (firstDot === -1) {
    throw new Error(`Invalid setting key: ${key}. Must include section (e.g., 'workbench.sideBar.location')`);
  }
  const section = key.slice(0, firstDot);
  const property = key.slice(firstDot + 1);

  const config = vscode.workspace.getConfiguration(section);
  return config.get<T>(property);
}

export function getEditorAssociations(): EditorAssociation[] {
  const value = getSetting<unknown>('workbench.editorAssociations');
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is EditorAssociation => {
    return !!entry && typeof entry === 'object';
  });
}

export async function setEditorAssociations(associations: EditorAssociation[]): Promise<void> {
  await updateSettings({ 'workbench.editorAssociations': associations });
}

export async function setMarkdownEditorAssociation(enabled: boolean): Promise<void> {
  const current = getEditorAssociations();
  const withoutAgents = current.filter((entry) => {
    return !(
      entry.viewType === 'agents.markdownEditor' &&
      entry.filenamePattern === '*.md'
    );
  });

  if (!enabled) {
    const hasOtherMarkdown = withoutAgents.some((entry) => {
      return entry.filenamePattern === '*.md';
    });
    const next = hasOtherMarkdown
      ? withoutAgents
      : [{ viewType: 'default', filenamePattern: '*.md' }, ...withoutAgents];
    await setEditorAssociations(next);
    return;
  }

  const withoutMarkdown = withoutAgents.filter((entry) => {
    return entry.filenamePattern !== '*.md';
  });
  const next = [
    { viewType: 'agents.markdownEditor', filenamePattern: '*.md' },
    ...withoutMarkdown
  ];
  await setEditorAssociations(next);
}

/**
 * Streamline layout: sidebar right, activity bar hidden.
 */
export async function enableStreamlineLayout(): Promise<void> {
  await updateSettings({
    'workbench.sideBar.location': 'right',
    // VS Code replaced the boolean `workbench.activityBar.visible` with a string `workbench.activityBar.location`.
    // `hidden` removes the activity bar while keeping other layout settings intact.
    'workbench.activityBar.location': 'hidden'
  });
}

/**
 * Normal layout: sidebar left, activity bar visible.
 */
export async function disableStreamlineLayout(): Promise<void> {
  await updateSettings({
    'workbench.sideBar.location': 'left',
    // Restore the default placement of the activity bar.
    'workbench.activityBar.location': 'side'
  });
}

/**
 * Check if streamline layout is currently active.
 */
export function isStreamlineLayout(): boolean {
  const sidebarLocation = getSetting<string>('workbench.sideBar.location');
  const activityBarLocation = getSetting<string>('workbench.activityBar.location');
  return sidebarLocation === 'right' && activityBarLocation === 'hidden';
}

/**
 * Toggle streamline layout on/off.
 */
export async function toggleStreamlineLayout(): Promise<boolean> {
  const streamlined = isStreamlineLayout();
  if (streamlined) {
    await disableStreamlineLayout();
    return false;
  } else {
    await enableStreamlineLayout();
    return true;
  }
}
