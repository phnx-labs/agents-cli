// Central theme detection and icon utilities
// VS Code's activeColorTheme.kind takes precedence over system settings

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export type ThemeMode = 'light' | 'dark';

// Icons that have light variants (dark logo for light backgrounds)
const ICONS_WITH_LIGHT_VARIANTS = new Set([
  'chatgpt.png',
  'cursor.png'
]);

/**
 * Get current theme mode from VS Code.
 * VS Code theme takes precedence over system settings.
 */
export function getThemeMode(): ThemeMode {
  const kind = vscode.window.activeColorTheme.kind;
  // Light (1) and HighContrastLight (4) are light themes
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark';
}

/**
 * Check if current theme is light.
 */
export function isLightTheme(): boolean {
  return getThemeMode() === 'light';
}

/**
 * Get the light variant filename for an icon (if it exists).
 * e.g., "chatgpt.png" -> "chatgpt-light.png"
 */
export function getLightVariant(iconFilename: string): string | null {
  if (!ICONS_WITH_LIGHT_VARIANTS.has(iconFilename)) {
    return null;
  }
  const ext = path.extname(iconFilename);
  const base = path.basename(iconFilename, ext);
  return `${base}-light${ext}`;
}

/**
 * Check if a light variant exists for the given icon.
 */
export function hasLightVariant(iconFilename: string): boolean {
  return ICONS_WITH_LIGHT_VARIANTS.has(iconFilename);
}

/**
 * Build VS Code icon path with light/dark variants.
 * For icons with light variants: uses {icon}-light.png for light theme, {icon}.png for dark.
 * For icons without variants: uses the same file for both.
 */
export function buildIconPath(extensionPath: string, iconFilename: string): vscode.IconPath {
  const assetsPath = path.join(extensionPath, 'assets');
  const darkIcon = vscode.Uri.file(path.join(assetsPath, iconFilename));

  const lightVariant = getLightVariant(iconFilename);
  const lightIcon = lightVariant
    ? vscode.Uri.file(path.join(assetsPath, lightVariant))
    : darkIcon;

  return { light: lightIcon, dark: darkIcon };
}

/**
 * Build icon path using extension URI (for webview contexts).
 * Returns the specific { light: Uri; dark: Uri } shape for panel.iconPath.
 */
export function buildIconPathFromUri(extensionUri: vscode.Uri, iconFilename: string): { light: vscode.Uri; dark: vscode.Uri } {
  const darkIcon = vscode.Uri.joinPath(extensionUri, 'assets', iconFilename);

  const lightVariant = getLightVariant(iconFilename);
  const lightIcon = lightVariant
    ? vscode.Uri.joinPath(extensionUri, 'assets', lightVariant)
    : darkIcon;

  return { light: lightIcon, dark: darkIcon };
}

/**
 * Subscribe to theme changes.
 * Returns a disposable that should be added to context.subscriptions.
 */
export function onThemeChange(callback: (mode: ThemeMode) => void): vscode.Disposable {
  return vscode.window.onDidChangeActiveColorTheme(() => {
    callback(getThemeMode());
  });
}
