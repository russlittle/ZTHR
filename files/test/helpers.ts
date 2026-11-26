import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { memoryObjects, type ObjectStore } from '../../intent/blocks/objects/index.ts';
import { Files, type Options } from '../src/app.ts';
import { serve } from '../src/server.ts';
import { State, memoryPersist, type Persist } from '../src/state.ts';

export interface Running {
  readonly files: Files;
  readonly base: string;
  readonly server: Server;
  readonly persist: Persist;
  readonly objects: ObjectStore;
  close(): Promise<void>;
  /** A fetch that signs in as someone. */
  as(user: string, password: string): (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<Response>;
  anon(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response>;
}

export const PASS = 'correct horse battery';

export async function start(o: Options & { persist?: Persist; objects?: ObjectStore; people?: { id: string; admin?: boolean; quota?: number | null; groups?: string[] }[] } = {}): Promise<Running> {
  const persist = o.persist ?? memoryPersist();
  const objects = o.objects ?? memoryObjects();
  const files = new Files(await State.open(persist), objects, o);
  for (const p of o.people ?? [{ id: 'ana', admin: true }, { id: 'ben' }]) if (!files.person(p.id)) await files.addPerson(p.id, PASS, { ...(p.admin ? { admin: true } : {}), ...(p.quota !== undefined ? { quota: p.quota } : {}), ...(p.groups ? { groups: p.groups } : {}), display: p.id[0]!.toUpperCase() + p.id.slice(1) });
  const server = await serve(files, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const go = (auth: string | null) => (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${base}${path}`, { ...init, redirect: 'manual', headers: { ...(auth ? { authorization: auth } : {}), ...(init.headers ?? {}) } });
  return {
    files,
    base,
    server,
    persist,
    objects,
    close: async () => {
      await files.state.flush();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
    as: (user, password) => go(`Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`),
    anon: go(null),
  };
}

export const PROPS = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:getetag/><d:getcontentlength/><d:resourcetype/><oc:fileid/><oc:id/><oc:permissions/><oc:size/><oc:checksums/><oc:share-types/><nc:mount-type/><oc:owner-id/><nc:nope/></d:prop></d:propfind>`;

/** The responses of a multistatus, as href and a map of property name to text. */
export function parseMultistatus(xml: string): { href: string; props: Record<string, string>; missing: string[] }[] {
  const out: { href: string; props: Record<string, string>; missing: string[] }[] = [];
  for (const m of xml.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
    const body = m[1]!;
    const href = decodeURIComponent(/<d:href>([^<]*)<\/d:href>/.exec(body)?.[1] ?? '');
    const props: Record<string, string> = {};
    const missing: string[] = [];
    for (const ps of body.matchAll(/<d:propstat><d:prop>([\s\S]*?)<\/d:prop><d:status>HTTP\/1.1 (\d+)[^<]*<\/d:status><\/d:propstat>/g)) {
      for (const p of ps[1]!.matchAll(/<((?:d|oc|nc):[a-z-_]+)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
        if (ps[2] === '200') props[p[1]!] = p[2] ?? '';
        else missing.push(p[1]!);
      }
    }
    out.push({ href, props, missing });
  }
  return out;
}
