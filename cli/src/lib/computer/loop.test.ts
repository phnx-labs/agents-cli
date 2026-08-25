import { describe, expect, it } from 'vitest';
import {
  runComputerLoop,
  isAxOpaque,
  AX_OPAQUE_ELEMENT_THRESHOLD,
  type ModelDecision,
  type ModelResponder,
  type VerbCall,
  type VerbResult,
} from './loop.js';

// A scripted model: returns each decision in sequence, one per turn. The LLM is
// a boundary, so we inject a deterministic stand-in — the loop is the code
// under test, never the model.
function scriptResponder(script: ModelDecision[]): ModelResponder {
  let i = 0;
  return () => {
    const next = script[i] ?? { toolCalls: [] };
    i++;
    return next;
  };
}

// A dispatcher that records every verb it saw and returns a scripted result per
// verb name (falling back to a generic ok). Records ordering so tests can
// assert the loop drove verbs in the right sequence.
function fakeDispatcher(results: Record<string, VerbResult> = {}) {
  const seen: VerbCall[] = [];
  const dispatch = (call: VerbCall): VerbResult => {
    seen.push(call);
    return results[call.name] ?? { ok: true, result: {} };
  };
  return { dispatch, seen };
}

describe('isAxOpaque', () => {
  it('honors an explicit ax_opaque flag from the daemon', () => {
    expect(isAxOpaque({ ok: true, result: { ax_opaque: true, element_count: 999 } })).toBe(true);
  });

  it('treats a shallow tree (element_count at/under threshold) as opaque', () => {
    expect(isAxOpaque({ ok: true, result: { element_count: AX_OPAQUE_ELEMENT_THRESHOLD } })).toBe(true);
    expect(isAxOpaque({ ok: true, result: { element_count: AX_OPAQUE_ELEMENT_THRESHOLD + 1 } })).toBe(false);
  });

  it('treats a childless tree as opaque when no element_count is present', () => {
    expect(isAxOpaque({ ok: true, result: { tree: { role: 'AXApplication', children: [] } } })).toBe(true);
    expect(isAxOpaque({ ok: true, result: { tree: { role: 'AXApplication', children: [{}, {}] } } })).toBe(false);
  });

  it('does not call a failed describe opaque — an error is not an empty tree', () => {
    expect(isAxOpaque({ ok: false, error: 'app_missing' })).toBe(false);
  });
});

describe('runComputerLoop', () => {
  it('dispatches the model tool calls in order', async () => {
    const script: ModelDecision[] = [
      { toolCalls: [{ name: 'describe', input: { pid: 42 } }] },
      { toolCalls: [{ name: 'click', input: { pid: 42, id: '@e1' } }] },
      { toolCalls: [], done: { text: 'done' } },
    ];
    // describe returns a rich tree so the vision fallback does NOT fire.
    const { dispatch, seen } = fakeDispatcher({
      describe: { ok: true, result: { element_count: 50, tree: { children: [{}, {}] } } },
    });

    const res = await runComputerLoop({ task: 't', responder: scriptResponder(script), dispatch, maxSteps: 10 });

    expect(res.status).toBe('done');
    expect(res.finalText).toBe('done');
    expect(res.dispatched).toEqual(['describe', 'click']);
    expect(seen.map((c) => c.name)).toEqual(['describe', 'click']);
    expect(res.visionMode).toBe(false);
  });

  it('honors maxSteps when the model never declares done', async () => {
    // Model asks for a key press every turn, forever.
    const responder: ModelResponder = () => ({ toolCalls: [{ name: 'key', input: { keys: 'esc' } }] });
    const { dispatch, seen } = fakeDispatcher();

    const res = await runComputerLoop({ task: 't', responder, dispatch, maxSteps: 3 });

    expect(res.status).toBe('max_steps');
    expect(res.turns).toBe(3);
    // One key dispatch per turn, capped at maxSteps.
    expect(seen.map((c) => c.name)).toEqual(['key', 'key', 'key']);
  });

  it('switches to the vision path when describe returns ax_opaque', async () => {
    const script: ModelDecision[] = [
      { toolCalls: [{ name: 'describe', input: { pid: 7, bundle: 'com.example.web' } }] },
      { toolCalls: [{ name: 'click', input: { x: 100, y: 200 } }] },
      { toolCalls: [], done: { text: 'ok' } },
    ];
    // Opaque describe (WebView-style): explicit flag from the daemon.
    const { dispatch, seen } = fakeDispatcher({
      describe: { ok: true, result: { ax_opaque: true, element_count: 1 } },
      screenshot: { ok: true, result: { width: 800, height: 600 } },
    });

    const res = await runComputerLoop({ task: 't', responder: scriptResponder(script), dispatch, maxSteps: 10 });

    // The loop auto-injects a screenshot right after the opaque describe — the
    // vision switch — then continues with the model's coordinate click.
    expect(res.dispatched).toEqual(['describe', 'screenshot', 'click']);
    expect(res.visionMode).toBe(true);

    // The auto-injected screenshot inherits the describe's target selector.
    const shot = seen.find((c) => c.name === 'screenshot');
    expect(shot?.input).toEqual({ pid: 7, bundle: 'com.example.web' });

    // The opaque describe step is marked as the fallback trigger.
    const describeStep = res.steps.find((s) => s.call.name === 'describe');
    expect(describeStep?.visionFallback).toBe(true);
  });

  it('does not fire the vision fallback for a rich describe', async () => {
    const script: ModelDecision[] = [
      { toolCalls: [{ name: 'describe', input: { pid: 1 } }] },
      { toolCalls: [], done: { text: 'ok' } },
    ];
    const { dispatch } = fakeDispatcher({
      describe: { ok: true, result: { element_count: 120, tree: { children: [{}, {}, {}] } } },
    });

    const res = await runComputerLoop({ task: 't', responder: scriptResponder(script), dispatch, maxSteps: 10 });

    expect(res.dispatched).toEqual(['describe']);
    expect(res.visionMode).toBe(false);
  });

  it('streams events for turns, dispatches, and the vision switch', async () => {
    const script: ModelDecision[] = [
      { toolCalls: [{ name: 'describe', input: { pid: 9 } }] },
      { toolCalls: [], done: { text: 'fin' } },
    ];
    const { dispatch } = fakeDispatcher({
      describe: { ok: true, result: { ax_opaque: true } },
    });
    const events: string[] = [];

    await runComputerLoop({
      task: 't',
      responder: scriptResponder(script),
      dispatch,
      maxSteps: 10,
      onEvent: (e) => events.push(e.kind),
    });

    expect(events).toContain('vision_switch');
    expect(events).toContain('done');
    expect(events.filter((e) => e === 'dispatch').length).toBe(2); // describe + auto screenshot
  });
});
