import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import {
  mimeFromExt,
  detectUploadPattern,
  uploadToFileInput,
  uploadToDropTarget,
  uploadViaFileChooser,
} from './upload.js';
import type { CDPClient } from './cdp.js';

function makeTempFile(ext: string, bytes: Buffer = Buffer.from('hello')): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'upload-test-'));
  const p = path.join(dir, `f${ext}`);
  fs.writeFileSync(p, bytes);
  return p;
}

interface MockSend {
  (method: string, params?: Record<string, unknown>): unknown;
}

function makeCdp(send: MockSend): { cdp: CDPClient; calls: Array<{ method: string; params: any }> } {
  const calls: Array<{ method: string; params: any }> = [];
  const handlers = new Map<string, Set<(p: any) => void>>();
  const cdp: any = {
    async send(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params: params ?? {} });
      return send(method, params);
    },
    on(event: string, handler: (p: any) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    off(event: string, handler: (p: any) => void) {
      handlers.get(event)?.delete(handler);
    },
    _emit(event: string, params: any) {
      handlers.get(event)?.forEach((h) => h(params));
    },
  };
  return { cdp: cdp as CDPClient, calls };
}

describe('mimeFromExt', () => {
  it('maps common image extensions', () => {
    expect(mimeFromExt('/x/logo.png')).toBe('image/png');
    expect(mimeFromExt('/x/photo.JPG')).toBe('image/jpeg');
    expect(mimeFromExt('/x/photo.jpeg')).toBe('image/jpeg');
    expect(mimeFromExt('/x/icon.svg')).toBe('image/svg+xml');
  });

  it('falls back to octet-stream for unknown extensions', () => {
    expect(mimeFromExt('/x/file.xyz')).toBe('application/octet-stream');
    expect(mimeFromExt('/x/noext')).toBe('application/octet-stream');
  });
});

describe('uploadToFileInput', () => {
  it('walks up to the <input type=file> and calls DOM.setFileInputFiles with its backendNodeId', async () => {
    const file = makeTempFile('.png');
    const { cdp, calls } = makeCdp((method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'wrapper-obj' } };
      if (method === 'Runtime.callFunctionOn') return { result: { objectId: 'input-obj' } };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 777 } };
      return {};
    });
    await uploadToFileInput(cdp, 'session-1', 42, [file]);
    const setCall = calls.find((c) => c.method === 'DOM.setFileInputFiles');
    expect(setCall).toBeTruthy();
    expect(setCall!.params.backendNodeId).toBe(777);
    expect(setCall!.params.files).toEqual([file]);
  });

  it('throws a clear error when the ref is not contained in an <input type=file>', async () => {
    const file = makeTempFile('.png');
    const { cdp } = makeCdp((method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj' } };
      if (method === 'Runtime.callFunctionOn') return { result: {} };
      return {};
    });
    await expect(uploadToFileInput(cdp, 'session-1', 42, [file])).rejects.toThrow(
      /not \(and is not contained in\) an <input type=file>/
    );
  });

  it('rejects relative paths', async () => {
    const { cdp } = makeCdp(() => ({}));
    await expect(uploadToFileInput(cdp, 'session-1', 42, ['relative.png'])).rejects.toThrow(
      /must be absolute/
    );
  });

  it('rejects missing files', async () => {
    const { cdp } = makeCdp(() => ({}));
    await expect(
      uploadToFileInput(cdp, 'session-1', 42, ['/nonexistent/path.png'])
    ).rejects.toThrow(/File not found/);
  });

  it('rejects empty file list', async () => {
    const { cdp } = makeCdp(() => ({}));
    await expect(uploadToFileInput(cdp, 'session-1', 42, [])).rejects.toThrow(
      /At least one file path is required/
    );
  });
});

describe('uploadToDropTarget', () => {
  it('resolves the node, dispatches drag-drop, and releases the object', async () => {
    const file = makeTempFile('.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { cdp, calls } = makeCdp((method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { dispatched: 3, files: 1 } } };
      return {};
    });

    await uploadToDropTarget(cdp, 'session-1', 99, [file]);

    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(['DOM.resolveNode', 'Runtime.callFunctionOn', 'Runtime.releaseObject']);

    const callOn = calls[1];
    expect(callOn.params.objectId).toBe('obj-1');
    expect(callOn.params.arguments).toHaveLength(1);
    const arg = callOn.params.arguments[0].value;
    expect(arg).toHaveLength(1);
    expect(arg[0].name).toBe(path.basename(file));
    expect(arg[0].type).toBe('image/png');
    // base64 of [0x89, 0x50, 0x4e, 0x47]:
    expect(arg[0].bytes).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  });

  it('releases the object even when callFunctionOn throws', async () => {
    const file = makeTempFile('.png');
    const { cdp, calls } = makeCdp((method) => {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-2' } };
      if (method === 'Runtime.callFunctionOn') throw new Error('boom');
      return {};
    });

    await expect(uploadToDropTarget(cdp, 'session-1', 99, [file])).rejects.toThrow('boom');
    expect(calls[calls.length - 1].method).toBe('Runtime.releaseObject');
  });

  it('throws when the node cannot be resolved (no objectId)', async () => {
    const file = makeTempFile('.png');
    const { cdp } = makeCdp((method) => {
      if (method === 'DOM.resolveNode') return { object: {} };
      return {};
    });
    await expect(uploadToDropTarget(cdp, 'session-1', 99, [file])).rejects.toThrow(
      /Drop target node could not be resolved/
    );
  });
});

describe('uploadViaFileChooser', () => {
  it('enables interception, clicks, accepts files on chooser event, then disables', async () => {
    const file = makeTempFile('.png');
    const ref = {
      node: { ref: 1, role: 'button', name: 'Upload', attrs: [], backendNodeId: 7 },
      nodeMap: new Map([[1, { ref: 1, role: 'button', name: 'Upload', attrs: [], backendNodeId: 7 }]]),
    };

    const { cdp, calls } = makeCdp((method) => {
      if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } };
      return {};
    });

    // Fire the chooser event right after the click is dispatched.
    const original = (cdp as any).send.bind(cdp);
    (cdp as any).send = async (method: string, params?: any) => {
      const r = await original(method, params);
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        (cdp as any)._emit('Page.fileChooserOpened', { backendNodeId: 123, mode: 'selectSingle' });
      }
      return r;
    };

    await uploadViaFileChooser(cdp, 'session-1', ref as any, [file]);

    const methods = calls.map((c) => c.method);
    expect(methods).toContain('Page.setInterceptFileChooserDialog');
    expect(methods).toContain('Page.handleFileChooser');

    const handle = calls.find((c) => c.method === 'Page.handleFileChooser')!;
    expect(handle.params).toEqual({ action: 'accept', files: [file] });

    const disables = calls.filter(
      (c) => c.method === 'Page.setInterceptFileChooserDialog' && c.params?.enabled === false
    );
    expect(disables.length).toBe(1);
  });

  it('times out if the chooser never opens', async () => {
    const file = makeTempFile('.png');
    const ref = {
      node: { ref: 1, role: 'button', name: 'X', attrs: [], backendNodeId: 7 },
      nodeMap: new Map([[1, { ref: 1, role: 'button', name: 'X', attrs: [], backendNodeId: 7 }]]),
    };
    const { cdp } = makeCdp((method) => {
      if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      return {};
    });

    await expect(
      uploadViaFileChooser(cdp, 'session-1', ref as any, [file], 25)
    ).rejects.toThrow(/did not open within 25ms/);
  });
});

describe('detectUploadPattern', () => {
  it("returns 'input' for <input type=file>", async () => {
    const { cdp } = makeCdp((method) => {
      if (method === 'DOM.describeNode')
        return { node: { nodeName: 'INPUT', attributes: ['type', 'file', 'name', 'logo'] } };
      return {};
    });
    expect(await detectUploadPattern(cdp, 'session-1', 1)).toBe('input');
  });

  it("returns 'drop' for non-input nodes that aren't inside a file input", async () => {
    const { cdp } = makeCdp((method) => {
      if (method === 'DOM.describeNode') return { node: { nodeName: 'DIV', attributes: [] } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj' } };
      if (method === 'Runtime.callFunctionOn') return { result: {} };
      return {};
    });
    expect(await detectUploadPattern(cdp, 'session-1', 1)).toBe('drop');
  });

  it("returns 'drop' for <input type=text>", async () => {
    const { cdp } = makeCdp((method) => {
      if (method === 'DOM.describeNode')
        return { node: { nodeName: 'INPUT', attributes: ['type', 'text'] } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj' } };
      if (method === 'Runtime.callFunctionOn') return { result: {} };
      return {};
    });
    expect(await detectUploadPattern(cdp, 'session-1', 1)).toBe('drop');
  });

  it('is case-insensitive on the type attribute value', async () => {
    const { cdp } = makeCdp((method) => {
      if (method === 'DOM.describeNode')
        return { node: { nodeName: 'INPUT', attributes: ['type', 'FILE'] } };
      return {};
    });
    expect(await detectUploadPattern(cdp, 'session-1', 1)).toBe('input');
  });

  it("returns 'input' when the ref is a button wrapper inside an <input type=file>", async () => {
    const { cdp } = makeCdp((method) => {
      if (method === 'DOM.describeNode')
        return { node: { nodeName: 'BUTTON', attributes: [] } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'wrapper-obj' } };
      if (method === 'Runtime.callFunctionOn') return { result: { objectId: 'input-obj' } };
      return {};
    });
    expect(await detectUploadPattern(cdp, 'session-1', 1)).toBe('input');
  });
});
