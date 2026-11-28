/**
 * Device sessions: a new app signs in through a browser once and gets its own long random app password, which is
 * stored only as a hash and can be revoked or marked for remote wipe without touching any other device. The login
 * flow hands the password over exactly once, to whoever holds the poll token, and expires if nobody finishes it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Device {
  readonly id: number;
  readonly user: string;
  readonly name: string;
  readonly hash: string;
  readonly created: number;
  readonly lastUsed: number;
  /** Marked for wipe: the device is told to erase itself, and the password no longer signs in. */
  readonly wipe: boolean;
}

export interface Flow {
  readonly poll: string;
  readonly login: string;
  readonly started: number;
  readonly client: string;
  /** Filled when a person approves it; handed over once and then the flow is gone. */
  readonly result?: { readonly user: string; readonly password: string };
}

export interface DeviceStore {
  all(): Promise<Device[]>;
  /** The device whose password hashes to this: an indexed lookup, since every request signs in with one. */
  byHash(hash: string): Promise<Device | undefined>;
  set(d: Device): Promise<void>;
  delete(id: number): Promise<void>;
  nextId(): Promise<number>;
  flows: {
    get(key: string): Promise<Flow | undefined>;
    set(f: Flow): Promise<void>;
    delete(f: Flow): Promise<void>;
  };
}

export function memoryDevices(): DeviceStore {
  const d = new Map<number, Device>();
  const byPoll = new Map<string, Flow>();
  const byLogin = new Map<string, Flow>();
  let n = 0;
  return {
    all: async () => [...d.values()],
    byHash: async (h) => [...d.values()].find((x) => x.hash === h),
    set: async (x) => void d.set(x.id, x),
    delete: async (id) => void d.delete(id),
    nextId: async () => ++n,
    flows: {
      get: async (k) => byPoll.get(k) ?? byLogin.get(k),
      set: async (f) => {
        byPoll.set(f.poll, f);
        byLogin.set(f.login, f);
      },
      delete: async (f) => {
        byPoll.delete(f.poll);
        byLogin.delete(f.login);
      },
    },
  };
}

export class NotSignedIn extends Error {
  constructor() {
    super('that name and app password do not sign in');
  }
}

export class FlowGone extends Error {
  constructor() {
    super('that sign-in is finished, expired, or never started');
  }
}

const token = (bytes: number) => randomBytes(bytes).toString('base64url');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface DevicesOptions {
  readonly now?: () => number;
  readonly flowMs?: number;
  /** Only write "last used" this often, so every request is not a write. */
  readonly touchMs?: number;
}

export class Devices {
  private readonly store: DeviceStore;
  private readonly now: () => number;
  private readonly flowMs: number;
  private readonly touchMs: number;

  constructor(store: DeviceStore, o: DevicesOptions = {}) {
    this.store = store;
    this.now = o.now ?? Date.now;
    this.flowMs = o.flowMs ?? 20 * 60_000;
    this.touchMs = o.touchMs ?? 60_000;
  }

  /** A new app password for a user's device; the plain text is returned once and never kept. */
  async issue(user: string, name: string): Promise<{ device: Device; password: string }> {
    const password = token(54);
    const device: Device = { id: await this.store.nextId(), user, name: name.slice(0, 120) || 'unnamed device', hash: hash(password), created: this.now(), lastUsed: this.now(), wipe: false };
    await this.store.set(device);
    return { device, password };
  }

  /** The device a name and app password belong to; a wiped or revoked one does not sign in. */
  async verify(user: string, password: string): Promise<Device> {
    const h = hash(password);
    const found = await this.store.byHash(h);
    const d = found && found.user === user && same(found.hash, h) ? found : undefined;
    if (!d || d.wipe) throw new NotSignedIn();
    if (this.now() - d.lastUsed > this.touchMs) {
      const next = { ...d, lastUsed: this.now() };
      await this.store.set(next);
      return next;
    }
    return d;
  }

  async list(user: string): Promise<Device[]> {
    return (await this.store.all()).filter((d) => d.user === user).sort((a, b) => a.id - b.id);
  }

  async revoke(user: string, id: number): Promise<void> {
    const d = (await this.store.all()).find((x) => x.id === id && x.user === user);
    if (d) await this.store.delete(d.id);
  }

  async markWipe(user: string, id: number): Promise<void> {
    const d = (await this.store.all()).find((x) => x.id === id && x.user === user);
    if (d) await this.store.set({ ...d, wipe: true });
  }

  /** A device asks, with its own password, whether it must erase itself. */
  async mustWipe(password: string): Promise<boolean> {
    return !!(await this.store.byHash(hash(password)))?.wipe;
  }

  /** The device reports it erased itself; its record goes. */
  async wiped(password: string): Promise<boolean> {
    const d = await this.store.byHash(hash(password));
    if (!d?.wipe) return false;
    await this.store.delete(d.id);
    return true;
  }

  /** Starts a sign-in for a new app: it polls with `poll`; the person opens the page that carries `login`. */
  async startFlow(client: string): Promise<Flow> {
    const f: Flow = { poll: token(48), login: token(48), started: this.now(), client: client.slice(0, 120) || 'unnamed device' };
    await this.store.flows.set(f);
    return f;
  }

  private async liveFlow(key: string): Promise<Flow> {
    const f = await this.store.flows.get(key);
    if (!f) throw new FlowGone();
    if (this.now() - f.started > this.flowMs) {
      await this.store.flows.delete(f);
      throw new FlowGone();
    }
    return f;
  }

  /** The person, signed in in the browser, approves the app; its password is made now and waits for the poll. */
  async approve(login: string, user: string): Promise<Device> {
    const f = await this.liveFlow(login);
    if (f.login !== login || f.result) throw new FlowGone();
    const { device, password } = await this.issue(user, f.client);
    await this.store.flows.set({ ...f, result: { user, password } });
    return device;
  }

  /** The app polls: nothing yet, or its credentials exactly once. */
  async poll(poll: string): Promise<{ user: string; password: string } | null> {
    const f = await this.liveFlow(poll);
    if (f.poll !== poll) throw new FlowGone();
    if (!f.result) return null;
    await this.store.flows.delete(f);
    return f.result;
  }
}
