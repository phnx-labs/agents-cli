import { describe, it, expect } from 'vitest';
import { computeActor, actorEnv, actorFromIdentity, type ResolvedActor } from './actor.js';

describe('computeActor', () => {
  it('inherits an actor an ancestor stamped into the env, without re-resolving', () => {
    const env: NodeJS.ProcessEnv = {
      AGENTS_ACTOR: 'bisma@example.com',
      AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Bisma',
      AGENTS_ACTOR_EMAIL: 'bisma@example.com',
      AGENTS_ACTOR_GITHUB: 'bisma',
      // An SSH_CONNECTION is present but must be ignored: inheritance wins so the
      // whole spawn tree shares one actor and we never shell out again.
      SSH_CONNECTION: '100.64.0.9 51000 100.64.0.1 22',
    };
    expect(computeActor(env)).toEqual<ResolvedActor>({
      id: 'bisma@example.com',
      kind: 'human',
      name: 'Bisma',
      email: 'bisma@example.com',
      github: 'bisma',
    });
  });

  it('inherits kind=agent verbatim', () => {
    const actor = computeActor({ AGENTS_ACTOR: 'scout', AGENTS_ACTOR_KIND: 'agent' });
    expect(actor.id).toBe('scout');
    expect(actor.kind).toBe('agent');
  });

  it('falls back to UNRESOLVED@<host> for a local (non-SSH) run', () => {
    const actor = computeActor({});
    expect(actor.id).toMatch(/^UNRESOLVED@/);
    expect(actor.kind).toBe('human');
    expect(actor.email).toBeUndefined();
    expect(actor.name).toBeUndefined();
  });

  it('does not shell out when SSH_CONNECTION is malformed (no client ip)', () => {
    const actor = computeActor({ SSH_CONNECTION: 'garbage' });
    expect(actor.id).toMatch(/^UNRESOLVED@/);
  });
});

describe('actorFromIdentity (the SSH-resolved enrich/override path)', () => {
  const whoMuqsit = { login: 'muqsitnawaz@gmail.com', displayName: 'Muqsit' };

  it('credits git straight from the tailnet identity when there is no actors entry', () => {
    expect(actorFromIdentity(whoMuqsit, 'yosemite-s1', {})).toEqual<ResolvedActor>({
      id: 'muqsitnawaz@gmail.com',
      kind: 'human',
      name: 'Muqsit',
      email: 'muqsitnawaz@gmail.com',
      github: undefined,
    });
  });

  it('enriches + overrides from an actors entry matched by map key', () => {
    const actors = {
      'muqsitnawaz@gmail.com': { name: 'Muqsit Nawaz', email: 'muqsit@company.com', github: 'muqsitnawaz' },
    };
    const actor = actorFromIdentity(whoMuqsit, 'h', actors);
    expect(actor.name).toBe('Muqsit Nawaz');       // overrides DisplayName
    expect(actor.email).toBe('muqsit@company.com'); // overrides the login email
    expect(actor.github).toBe('muqsitnawaz');
    expect(actor.id).toBe('muqsitnawaz@gmail.com'); // id stays the tailnet login
  });

  it('matches an entry by its explicit login field, case-insensitively', () => {
    const actors = { bisma: { login: 'BISMA@EXAMPLE.COM', name: 'Bisma', email: 'bisma@example.com' } };
    const actor = actorFromIdentity({ login: 'bisma@example.com' }, 'h', actors);
    expect(actor.name).toBe('Bisma');
    expect(actor.email).toBe('bisma@example.com');
  });

  it('matches an entry by its email field', () => {
    const actors = { b: { email: 'bisma@example.com', github: 'bee' } };
    const actor = actorFromIdentity({ login: 'bisma@example.com' }, 'h', actors);
    expect(actor.github).toBe('bee');
  });

  it('honors a kind: agent override (so an agent identity gets no personal git credit)', () => {
    const actors = { scout: { login: 'scout@bots', kind: 'agent' as const, name: 'Scout', email: 'scout@bots' } };
    const actor = actorFromIdentity({ login: 'scout@bots' }, 'h', actors);
    expect(actor.kind).toBe('agent');
    expect(actorEnv(actor).GIT_AUTHOR_NAME).toBeUndefined();
  });

  it('leaves email undefined for a non-email login with no config (no git credit)', () => {
    const actor = actorFromIdentity({ login: 'plainuser', displayName: 'Plain' }, 'h', {});
    expect(actor.email).toBeUndefined();
    expect(actorEnv(actor).GIT_AUTHOR_EMAIL).toBeUndefined();
  });

  it('falls back to UNRESOLVED@<host> when whois names no one', () => {
    expect(actorFromIdentity(undefined, 'zion', {})).toEqual<ResolvedActor>({ id: 'UNRESOLVED@zion', kind: 'human' });
  });
});

describe('actorEnv', () => {
  it('credits git for a resolved human with a real name + email', () => {
    const env = actorEnv({
      id: 'muqsitnawaz@gmail.com',
      kind: 'human',
      name: 'Muqsit',
      email: 'muqsitnawaz@gmail.com',
    });
    expect(env.AGENTS_ACTOR).toBe('muqsitnawaz@gmail.com');
    expect(env.AGENTS_ACTOR_KIND).toBe('human');
    expect(env.GIT_AUTHOR_NAME).toBe('Muqsit');
    expect(env.GIT_AUTHOR_EMAIL).toBe('muqsitnawaz@gmail.com');
    expect(env.GIT_COMMITTER_NAME).toBe('Muqsit');
    expect(env.GIT_COMMITTER_EMAIL).toBe('muqsitnawaz@gmail.com');
  });

  it('claims no git identity for an unresolved actor (keeps ambient git config)', () => {
    const env = actorEnv({ id: 'UNRESOLVED@zion', kind: 'human' });
    expect(env.AGENTS_ACTOR).toBe('UNRESOLVED@zion');
    expect(env.AGENTS_ACTOR_KIND).toBe('human');
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(env.GIT_COMMITTER_NAME).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it('does not give a non-human actor personal git credit', () => {
    const env = actorEnv({ id: 'scout', kind: 'agent', name: 'Scout', email: 'scout@bot' });
    expect(env.AGENTS_ACTOR_KIND).toBe('agent');
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
  });

  it('round-trips through the env: actorEnv output re-inherits to the same actor', () => {
    const actor: ResolvedActor = {
      id: 'bisma@example.com',
      kind: 'human',
      name: 'Bisma',
      email: 'bisma@example.com',
      github: 'bisma',
    };
    expect(computeActor(actorEnv(actor))).toEqual(actor);
  });

  // RUSH-2017/2028: two distinct origin identities must forward two distinct
  // git-author credits across the SSH hop. Before the dispatch fix both runs
  // re-resolved on the remote from the shared box's SSH_CONNECTION and collapsed
  // to one actor — this pins that they stay separate through actorEnv.
  it('two different resolved actors produce two different forwarded git identities', () => {
    const alice = actorEnv(computeActor({
      AGENTS_ACTOR: 'alice@example.com', AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Alice', AGENTS_ACTOR_EMAIL: 'alice@example.com',
    }));
    const bob = actorEnv(computeActor({
      AGENTS_ACTOR: 'bob@example.com', AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Bob', AGENTS_ACTOR_EMAIL: 'bob@example.com',
    }));
    expect(alice.AGENTS_ACTOR).toBe('alice@example.com');
    expect(alice.GIT_AUTHOR_NAME).toBe('Alice');
    expect(alice.GIT_AUTHOR_EMAIL).toBe('alice@example.com');
    expect(bob.AGENTS_ACTOR).toBe('bob@example.com');
    expect(bob.GIT_AUTHOR_NAME).toBe('Bob');
    expect(bob.GIT_AUTHOR_EMAIL).toBe('bob@example.com');
    expect(alice.GIT_AUTHOR_EMAIL).not.toBe(bob.GIT_AUTHOR_EMAIL);
  });
});
