import { describe, it, expect } from 'vitest';
import {
  escapeAppleScriptString,
  ARC_NATIVE_CAPABILITIES,
  ArcNativeCapabilityError,
} from './arc.js';

describe('escapeAppleScriptString', () => {
  it('escapes double quotes', () => {
    expect(escapeAppleScriptString('say "hello"')).toBe('say \\"hello\\"');
  });

  it('escapes backslashes', () => {
    expect(escapeAppleScriptString('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes newlines', () => {
    expect(escapeAppleScriptString('line1\nline2')).toBe('line1\\nline2');
  });

  it('escapes carriage returns', () => {
    expect(escapeAppleScriptString('line1\rline2')).toBe('line1\\rline2');
  });

  it('handles combined special characters', () => {
    expect(escapeAppleScriptString('"test"\n\\')).toBe('\\"test\\"\\n\\\\');
  });

  it('passes through plain strings unchanged', () => {
    expect(escapeAppleScriptString('hello world')).toBe('hello world');
  });

  it('handles URLs with colons and slashes', () => {
    const url = 'https://example.com:8080/path?q=a&r=b';
    expect(escapeAppleScriptString(url)).toBe(url);
  });
});

describe('ARC_NATIVE_CAPABILITIES', () => {
  it('declares supported capabilities', () => {
    expect(ARC_NATIVE_CAPABILITIES.createTab).toBe(true);
    expect(ARC_NATIVE_CAPABILITIES.navigate).toBe(true);
    expect(ARC_NATIVE_CAPABILITIES.evaluateSync).toBe(true);
    expect(ARC_NATIVE_CAPABILITIES.closeTab).toBe(true);
    expect(ARC_NATIVE_CAPABILITIES.enumerate).toBe(true);
  });

  it('declares unsupported capabilities as false', () => {
    expect(ARC_NATIVE_CAPABILITIES.screenshot).toBe(false);
    expect(ARC_NATIVE_CAPABILITIES.asyncEvaluate).toBe(false);
    expect(ARC_NATIVE_CAPABILITIES.networkCapture).toBe(false);
    expect(ARC_NATIVE_CAPABILITIES.consoleCapture).toBe(false);
    expect(ARC_NATIVE_CAPABILITIES.upload).toBe(false);
    expect(ARC_NATIVE_CAPABILITIES.pdf).toBe(false);
    expect(ARC_NATIVE_CAPABILITIES.background).toBe(false);
  });
});

describe('ArcNativeCapabilityError', () => {
  it('includes capability name in the message', () => {
    const err = new ArcNativeCapabilityError('screenshot');
    expect(err.capability).toBe('screenshot');
    expect(err.message).toContain('screenshot');
    expect(err.message).toContain('unavailable');
    expect(err.name).toBe('ArcNativeCapabilityError');
  });

  it('accepts a custom message', () => {
    const err = new ArcNativeCapabilityError('pdf', 'Custom reason');
    expect(err.message).toBe('Custom reason');
    expect(err.capability).toBe('pdf');
  });

  it('suggests Chromium alternative in default message', () => {
    const err = new ArcNativeCapabilityError('networkCapture');
    expect(err.message).toContain('comet');
    expect(err.message).toContain('Chromium-family');
  });
});
