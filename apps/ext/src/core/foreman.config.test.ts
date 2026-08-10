import { describe, test, expect } from 'bun:test';
import { FOREMAN_TOOLS, FOREMAN_SYSTEM_PROMPT } from './foreman.config';

// The P1 tool surface. A tool the model can call but the routing prompt never
// mentions gets misrouted or ignored; two tools sharing a name shadow each
// other. These guard the tool contract, not constants.
describe('FOREMAN_TOOLS contract', () => {
  test('tool names are unique', () => {
    const names = FOREMAN_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every tool has a valid object-schema and a non-empty description', () => {
    for (const t of FOREMAN_TOOLS) {
      expect(t.type).toBe('function');
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.parameters.type).toBe('object');
      // required params must actually be declared in properties
      for (const req of t.parameters.required ?? []) {
        expect(Object.keys(t.parameters.properties)).toContain(req);
      }
    }
  });

  test('every tool name appears in the routing prompt so it can be routed', () => {
    for (const t of FOREMAN_TOOLS) {
      expect(FOREMAN_SYSTEM_PROMPT).toContain(t.name);
    }
  });

  test('the P1 read tools are present', () => {
    const names = new Set(FOREMAN_TOOLS.map((t) => t.name));
    for (const n of ['team_detail', 'cloud_status', 'quota', 'routines', 'fleet']) {
      expect(names.has(n)).toBe(true);
    }
  });
});
