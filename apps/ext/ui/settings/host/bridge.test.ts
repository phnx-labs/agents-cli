import { test, expect } from 'bun:test'
import { selectHostKind } from './bridge'

test('selectHostKind prefers Electron when its preload bridge is present', () => {
  expect(selectHostKind(true, true)).toBe('electron')
  expect(selectHostKind(true, false)).toBe('electron')
})

test('selectHostKind falls back to VS Code when only acquireVsCodeApi exists', () => {
  expect(selectHostKind(false, true)).toBe('vscode')
})

test('selectHostKind reports none when neither host is available', () => {
  expect(selectHostKind(false, false)).toBe('none')
})
