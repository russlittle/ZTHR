/**
 * The registry of what a home or a site is made of: integrations (config entries), the devices they bring, the
 * entities each device exposes, and the areas (rooms, floors, zones) they sit in. Shaped after the registries of
 * Home Assistant: every entity has an internal id that never changes, a readable entity id ("light.kitchen_lamp")
 * that may be renamed, and a unique id given by its integration, so the same thing found again after a restart is
 * the same entity and keeps its name, area and settings. Handled here: entity ids made from names with a number
 * added on collision, renames that keep the old id as an alias, disabled and hidden entities (with the reason, so
 * re-enabling a device brings back only what the device had switched off), devices merged by shared identifiers,
 * an area tree that refuses loops, the area an entity is really in (its own, or its device's), removal of a config
 * entry with everything it brought, and a plain JSON snapshot to save and restore.
 *
 * Out of scope: state values, services and events of entities (see events and automation-engine); the registry
 * only says what exists and where it is.
 */

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export class NotFound extends RegistryError {}
export class Conflict extends RegistryError {}
export class InvalidId extends RegistryError {}

export type DisabledBy = 'user' | 'integration' | 'config_entry' | 'device';
export type HiddenBy = 'user' | 'integration';

export interface ConfigEntry {
  readonly id: string;
  readonly domain: string;
  readonly title: string;
  /** User switched the whole integration off. */
  readonly disabled: boolean;
}

export interface Device {
  readonly id: string;
  readonly configEntries: readonly string[];
  /** Pairs of [integration domain, identifier]: what makes it the same device next time. */
  readonly identifiers: readonly (readonly [string, string])[];
  /** Pairs of [kind, value], such as ["mac", "aa:bb:cc:dd:ee:ff"]. */
  readonly connections: readonly (readonly [string, string])[];
  readonly name: string;
  readonly nameByUser?: string;
  readonly manufacturer?: string;
  readonly model?: string;
  readonly areaId?: string;
  readonly viaDeviceId?: string;
  readonly disabledBy?: 'user' | 'config_entry';
}

export interface Entity {
  readonly id: string;
  readonly entityId: string;
  readonly platform: string;
  readonly uniqueId: string;
  readonly configEntryId?: string;
  readonly deviceId?: string;
  readonly areaId?: string;
  readonly originalName?: string;
  readonly name?: string;
  readonly aliases: readonly string[];
  readonly previousEntityIds: readonly string[];
  readonly disabledBy?: DisabledBy;
  readonly hiddenBy?: HiddenBy;
  readonly createdAt: number;
  readonly modifiedAt: number;
}

export interface Area {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly aliases: readonly string[];
  readonly icon?: string;
}

export interface Snapshot {
  readonly version: 1;
  readonly configEntries: readonly ConfigEntry[];
  readonly devices: readonly Device[];
  readonly entities: readonly Entity[];
  readonly areas: readonly Area[];
}

const ENTITY_ID = /^([a-z][a-z0-9_]*)\.([a-z0-9][a-z0-9_]*)$/;

/** "Kitchen Lamp #2" becomes "kitchen_lamp_2"; accents are folded and anything else becomes an underscore. */
export function slugify(text: string): string {
  const s = text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'unnamed';
}

export function splitEntityId(entityId: string): { domain: string; objectId: string } {
  const m = ENTITY_ID.exec(entityId);
  if (!m || entityId.length > 255) throw new InvalidId(`"${entityId}" is not an entity id of the form domain.object_id`);
  return { domain: m[1]!, objectId: m[2]! };
}

export interface RegistryOptions {
  /** Makes internal ids; injected so tests are repeatable. */
  readonly newId: () => string;
  readonly now?: () => number;
}

export interface EntityInput {
  readonly domain: string;
  readonly platform: string;
  readonly uniqueId: string;
  readonly configEntryId?: string;
  readonly deviceId?: string;
  readonly suggestedObjectId?: string;
  readonly originalName?: string;
  readonly disabledBy?: DisabledBy;
  readonly hiddenBy?: HiddenBy;
}

export interface DeviceInput {
  readonly configEntryId: string;
  readonly identifiers?: readonly (readonly [string, string])[];
  readonly connections?: readonly (readonly [string, string])[];
  readonly name: string;
  readonly manufacturer?: string;
  readonly model?: string;
  readonly viaDeviceId?: string;
}

const pairKey = (p: readonly [string, string]) => `${p[0]}\u0000${p[1].toLowerCase()}`;
const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

export class Registry {
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly entries = new Map<string, ConfigEntry>();
  private readonly devs = new Map<string, Device>();
  private readonly ents = new Map<string, Entity>();
  private readonly areas = new Map<string, Area>();

  constructor(o: RegistryOptions) {
    this.newId = o.newId;
    this.now = o.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------ config entries

  addConfigEntry(domain: string, title: string): ConfigEntry {
    if (!/^[a-z][a-z0-9_]*$/.test(domain)) throw new InvalidId(`"${domain}" is not an integration domain`);
    const e: ConfigEntry = { id: this.newId(), domain, title, disabled: false };
    this.entries.set(e.id, e);
    return e;
  }

  configEntry(id: string): ConfigEntry | undefined {
    return this.entries.get(id);
  }

  /** Switches an integration off or on; entities it owns follow, but only those it switched off itself. */
  setConfigEntryDisabled(id: string, disabled: boolean): void {
    const e = this.entries.get(id);
    if (!e) throw new NotFound(`no config entry ${id}`);
    this.entries.set(id, { ...e, disabled });
    for (const d of this.devs.values()) {
      if (!d.configEntries.includes(id)) continue;
      const live = d.configEntries.some((c) => !this.entries.get(c)?.disabled);
      if (!live && !d.disabledBy) this.devs.set(d.id, { ...d, disabledBy: 'config_entry' });
      if (live && d.disabledBy === 'config_entry') this.devs.set(d.id, withoutKey(d, 'disabledBy'));
    }
    for (const x of [...this.ents.values()]) {
      if (x.configEntryId !== id) continue;
      if (disabled && !x.disabledBy) this.patchEntity(x.id, { disabledBy: 'config_entry' });
      if (!disabled && x.disabledBy === 'config_entry') this.patchEntity(x.id, { disabledBy: undefined });
    }
  }

  /** Removes an integration with its entities and with every device that has no other integration left. */
  removeConfigEntry(id: string): { entities: string[]; devices: string[] } {
    if (!this.entries.has(id)) throw new NotFound(`no config entry ${id}`);
    const entities: string[] = [];
    const devices: string[] = [];
    for (const d of [...this.devs.values()]) {
      if (!d.configEntries.includes(id)) continue;
      const rest = d.configEntries.filter((c) => c !== id);
      if (rest.length) this.devs.set(d.id, { ...d, configEntries: rest });
      else {
        for (const x of [...this.ents.values()]) if (x.deviceId === d.id) {
          this.ents.delete(x.id);
          entities.push(x.entityId);
        }
        this.devs.delete(d.id);
        devices.push(d.id);
      }
    }
    for (const x of [...this.ents.values()]) if (x.configEntryId === id) {
      this.ents.delete(x.id);
      entities.push(x.entityId);
    }
    this.entries.delete(id);
    for (const d of this.devs.values()) if (d.viaDeviceId && devices.includes(d.viaDeviceId)) this.devs.set(d.id, withoutKey(d, 'viaDeviceId'));
    return { entities, devices };
  }

  // ------------------------------------------------------------ areas

  addArea(name: string, o: { parentId?: string; aliases?: readonly string[]; icon?: string } = {}): Area {
    const clean = name.trim();
    if (!clean) throw new InvalidId('an area needs a name');
    if (o.parentId !== undefined && !this.areas.has(o.parentId)) throw new NotFound(`no area ${o.parentId}`);
    for (const a of this.areas.values()) {
      if (a.parentId === o.parentId && a.name.toLowerCase() === clean.toLowerCase()) throw new Conflict(`there is already an area "${a.name}" here`);
    }
    const a: Area = { id: this.newId(), name: clean, aliases: [...(o.aliases ?? [])], ...(o.parentId !== undefined ? { parentId: o.parentId } : {}), ...(o.icon !== undefined ? { icon: o.icon } : {}) };
    this.areas.set(a.id, a);
    return a;
  }

  area(id: string): Area | undefined {
    return this.areas.get(id);
  }

  listAreas(): Area[] {
    return [...this.areas.values()];
  }

  renameArea(id: string, name: string): Area {
    const a = this.areas.get(id);
    if (!a) throw new NotFound(`no area ${id}`);
    const clean = name.trim();
    if (!clean) throw new InvalidId('an area needs a name');
    for (const b of this.areas.values()) if (b.id !== id && b.parentId === a.parentId && b.name.toLowerCase() === clean.toLowerCase()) throw new Conflict(`there is already an area "${b.name}" here`);
    const n = { ...a, name: clean };
    this.areas.set(id, n);
    return n;
  }

  /** Moves an area under another (or to the top with undefined); refuses to put it inside itself. */
  moveArea(id: string, parentId: string | undefined): Area {
    const a = this.areas.get(id);
    if (!a) throw new NotFound(`no area ${id}`);
    if (parentId !== undefined) {
      if (!this.areas.has(parentId)) throw new NotFound(`no area ${parentId}`);
      if (parentId === id || this.descendantAreas(id).some((d) => d.id === parentId)) throw new Conflict('an area cannot be moved inside itself');
    }
    for (const b of this.areas.values()) if (b.id !== id && b.parentId === parentId && b.name.toLowerCase() === a.name.toLowerCase()) throw new Conflict(`there is already an area "${b.name}" there`);
    const n = parentId === undefined ? withoutKey(a, 'parentId') : { ...a, parentId };
    this.areas.set(id, n);
    return n;
  }

  /** Removes an area. Its children move up one level; devices and entities in it become unassigned. */
  removeArea(id: string): void {
    const a = this.areas.get(id);
    if (!a) throw new NotFound(`no area ${id}`);
    for (const c of [...this.areas.values()]) if (c.parentId === id) this.areas.set(c.id, a.parentId === undefined ? withoutKey(c, 'parentId') : { ...c, parentId: a.parentId });
    for (const d of [...this.devs.values()]) if (d.areaId === id) this.devs.set(d.id, withoutKey(d, 'areaId'));
    for (const x of [...this.ents.values()]) if (x.areaId === id) this.patchEntity(x.id, { areaId: undefined });
    this.areas.delete(id);
  }

  /** From the top down: ["Ground floor", "Kitchen"]. */
  areaPath(id: string): string[] {
    const out: string[] = [];
    let cur = this.areas.get(id);
    if (!cur) throw new NotFound(`no area ${id}`);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur.name);
      cur = cur.parentId === undefined ? undefined : this.areas.get(cur.parentId);
    }
    return out;
  }

  descendantAreas(id: string): Area[] {
    const out: Area[] = [];
    const walk = (p: string) => {
      for (const a of this.areas.values()) if (a.parentId === p) {
        out.push(a);
        walk(a.id);
      }
    };
    walk(id);
    return out;
  }

  /** Finds an area by name or alias, ignoring case and accents. */
  findArea(text: string): Area | undefined {
    const k = slugify(text);
    return [...this.areas.values()].find((a) => slugify(a.name) === k || a.aliases.some((x) => slugify(x) === k));
  }

  // ------------------------------------------------------------ devices

  /** Finds the device these identifiers or connections already name, merging what is new; otherwise makes one. */
  getOrCreateDevice(i: DeviceInput): Device {
    const ids = (i.identifiers ?? []).map(pairKey);
    const cons = (i.connections ?? []).map(pairKey);
    if (!ids.length && !cons.length) throw new InvalidId('a device needs at least one identifier or connection');
    for (const d of this.devs.values()) {
      const hit = d.identifiers.some((p) => ids.includes(pairKey(p))) || d.connections.some((p) => cons.includes(pairKey(p)));
      if (!hit) continue;
      const merged: Device = {
        ...d,
        configEntries: uniq([...d.configEntries, i.configEntryId]),
        identifiers: mergePairs(d.identifiers, i.identifiers ?? []),
        connections: mergePairs(d.connections, i.connections ?? []),
        ...(i.manufacturer !== undefined ? { manufacturer: i.manufacturer } : {}),
        ...(i.model !== undefined ? { model: i.model } : {}),
        ...(i.viaDeviceId !== undefined ? { viaDeviceId: i.viaDeviceId } : {}),
      };
      this.devs.set(d.id, merged);
      return merged;
    }
    if (!this.entries.has(i.configEntryId)) throw new NotFound(`no config entry ${i.configEntryId}`);
    if (i.viaDeviceId !== undefined && !this.devs.has(i.viaDeviceId)) throw new NotFound(`no device ${i.viaDeviceId}`);
    const d: Device = {
      id: this.newId(),
      configEntries: [i.configEntryId],
      identifiers: mergePairs([], i.identifiers ?? []),
      connections: mergePairs([], i.connections ?? []),
      name: i.name,
      ...(i.manufacturer !== undefined ? { manufacturer: i.manufacturer } : {}),
      ...(i.model !== undefined ? { model: i.model } : {}),
      ...(i.viaDeviceId !== undefined ? { viaDeviceId: i.viaDeviceId } : {}),
    };
    this.devs.set(d.id, d);
    return d;
  }

  device(id: string): Device | undefined {
    return this.devs.get(id);
  }

  listDevices(o: { includeDisabled?: boolean } = {}): Device[] {
    return [...this.devs.values()].filter((d) => o.includeDisabled || !d.disabledBy);
  }

  setDeviceArea(id: string, areaId: string | undefined): Device {
    const d = this.devs.get(id);
    if (!d) throw new NotFound(`no device ${id}`);
    if (areaId !== undefined && !this.areas.has(areaId)) throw new NotFound(`no area ${areaId}`);
    const n = areaId === undefined ? withoutKey(d, 'areaId') : { ...d, areaId };
    this.devs.set(id, n);
    return n;
  }

  renameDevice(id: string, nameByUser: string | undefined): Device {
    const d = this.devs.get(id);
    if (!d) throw new NotFound(`no device ${id}`);
    const n = nameByUser === undefined ? withoutKey(d, 'nameByUser') : { ...d, nameByUser };
    this.devs.set(id, n);
    return n;
  }

  /** Disabling a device switches off its entities (marked "device"); enabling brings back only those. */
  setDeviceDisabled(id: string, disabled: boolean): void {
    const d = this.devs.get(id);
    if (!d) throw new NotFound(`no device ${id}`);
    if (disabled) {
      this.devs.set(id, { ...d, disabledBy: 'user' });
      for (const x of this.entitiesOfDevice(id, true)) if (!x.disabledBy) this.patchEntity(x.id, { disabledBy: 'device' });
    } else {
      if (d.disabledBy === 'config_entry') throw new Conflict('the device is off because its integration is off');
      this.devs.set(id, withoutKey(d, 'disabledBy'));
      for (const x of this.entitiesOfDevice(id, true)) if (x.disabledBy === 'device') this.patchEntity(x.id, { disabledBy: undefined });
    }
  }

  removeDevice(id: string): string[] {
    if (!this.devs.has(id)) throw new NotFound(`no device ${id}`);
    const gone = this.entitiesOfDevice(id, true).map((x) => x.entityId);
    for (const x of this.entitiesOfDevice(id, true)) this.ents.delete(x.id);
    this.devs.delete(id);
    for (const d of this.devs.values()) if (d.viaDeviceId === id) this.devs.set(d.id, withoutKey(d, 'viaDeviceId'));
    return gone;
  }

  // ------------------------------------------------------------ entities

  /**
   * Registers an entity, or returns the one already registered for the same platform and unique id. A new entity
   * gets an id from its suggested name; a number is added if that id is taken.
   */
  getOrCreateEntity(i: EntityInput): Entity {
    if (!/^[a-z][a-z0-9_]*$/.test(i.domain)) throw new InvalidId(`"${i.domain}" is not a domain`);
    if (!i.uniqueId) throw new InvalidId('an entity needs a unique id from its integration');
    const have = this.byUniqueId(i.platform, i.domain, i.uniqueId);
    if (have) return have;
    if (i.deviceId !== undefined && !this.devs.has(i.deviceId)) throw new NotFound(`no device ${i.deviceId}`);
    if (i.configEntryId !== undefined && !this.entries.has(i.configEntryId)) throw new NotFound(`no config entry ${i.configEntryId}`);
    const base = slugify(i.suggestedObjectId ?? i.originalName ?? i.uniqueId);
    const entityId = this.freeEntityId(i.domain, base);
    const dev = i.deviceId === undefined ? undefined : this.devs.get(i.deviceId);
    const entry = i.configEntryId === undefined ? undefined : this.entries.get(i.configEntryId);
    const inherited: DisabledBy | undefined = i.disabledBy ?? (dev?.disabledBy ? (dev.disabledBy === 'user' ? 'device' : 'config_entry') : entry?.disabled ? 'config_entry' : undefined);
    const t = this.now();
    const e: Entity = {
      id: this.newId(),
      entityId,
      platform: i.platform,
      uniqueId: i.uniqueId,
      aliases: [],
      previousEntityIds: [],
      createdAt: t,
      modifiedAt: t,
      ...(i.configEntryId !== undefined ? { configEntryId: i.configEntryId } : {}),
      ...(i.deviceId !== undefined ? { deviceId: i.deviceId } : {}),
      ...(i.originalName !== undefined ? { originalName: i.originalName } : {}),
      ...(inherited !== undefined ? { disabledBy: inherited } : {}),
      ...(i.hiddenBy !== undefined ? { hiddenBy: i.hiddenBy } : {}),
    };
    this.ents.set(e.id, e);
    return e;
  }

  private byUniqueId(platform: string, domain: string, uniqueId: string): Entity | undefined {
    for (const x of this.ents.values()) if (x.platform === platform && x.uniqueId === uniqueId && x.entityId.startsWith(`${domain}.`)) return x;
    return undefined;
  }

  private freeEntityId(domain: string, base: string, ignore?: string): string {
    const taken = (id: string) => [...this.ents.values()].some((x) => x.id !== ignore && (x.entityId === id));
    let id = `${domain}.${base}`;
    for (let n = 2; taken(id); n++) id = `${domain}.${base}_${n}`;
    return id;
  }

  /** Looks an entity up by its current entity id, or by an old one it was renamed from. */
  get(entityId: string): Entity | undefined {
    for (const x of this.ents.values()) if (x.entityId === entityId) return x;
    for (const x of this.ents.values()) if (x.previousEntityIds.includes(entityId)) return x;
    return undefined;
  }

  getById(id: string): Entity | undefined {
    return this.ents.get(id);
  }

  /** Renames an entity id. The domain cannot change; a taken id is refused; the old id stays as an alias. */
  renameEntityId(id: string, newEntityId: string): Entity {
    const x = this.ents.get(id);
    if (!x) throw new NotFound(`no entity ${id}`);
    const a = splitEntityId(x.entityId);
    const b = splitEntityId(newEntityId);
    if (a.domain !== b.domain) throw new Conflict(`the domain cannot change from ${a.domain} to ${b.domain}`);
    if (newEntityId === x.entityId) return x;
    const clash = [...this.ents.values()].find((o) => o.id !== id && o.entityId === newEntityId);
    if (clash) throw new Conflict(`${newEntityId} is already used`);
    return this.patchEntity(id, { entityId: newEntityId, previousEntityIds: uniq([...x.previousEntityIds.filter((p) => p !== newEntityId), x.entityId]) });
  }

  updateEntity(id: string, p: { name?: string | undefined; areaId?: string | undefined; aliases?: readonly string[]; hiddenBy?: HiddenBy | undefined }): Entity {
    if (p.areaId !== undefined && !this.areas.has(p.areaId)) throw new NotFound(`no area ${p.areaId}`);
    if (!this.ents.has(id)) throw new NotFound(`no entity ${id}`);
    return this.patchEntity(id, p);
  }

  setEntityDisabled(id: string, disabled: boolean, by: 'user' | 'integration' = 'user'): Entity {
    const x = this.ents.get(id);
    if (!x) throw new NotFound(`no entity ${id}`);
    if (disabled) return this.patchEntity(id, { disabledBy: x.disabledBy ?? by });
    if (x.disabledBy === 'device' || x.disabledBy === 'config_entry') throw new Conflict(`it is off because its ${x.disabledBy === 'device' ? 'device' : 'integration'} is off`);
    return this.patchEntity(id, { disabledBy: undefined });
  }

  removeEntity(id: string): void {
    if (!this.ents.delete(id)) throw new NotFound(`no entity ${id}`);
  }

  private patchEntity(id: string, p: Partial<Record<keyof Entity, unknown>>): Entity {
    const x = this.ents.get(id)!;
    const n: Record<string, unknown> = { ...x, modifiedAt: this.now() };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) delete n[k];
      else n[k] = v;
    }
    const out = n as unknown as Entity;
    this.ents.set(id, out);
    return out;
  }

  private entitiesOfDevice(deviceId: string, includeDisabled: boolean): Entity[] {
    return [...this.ents.values()].filter((x) => x.deviceId === deviceId && (includeDisabled || !x.disabledBy));
  }

  /** The name to show: the user's, else the integration's, else the device name plus the entity's own. */
  friendlyName(id: string): string {
    const x = this.ents.get(id);
    if (!x) throw new NotFound(`no entity ${id}`);
    if (x.name) return x.name;
    const d = x.deviceId === undefined ? undefined : this.devs.get(x.deviceId);
    const dn = d ? (d.nameByUser ?? d.name) : undefined;
    if (x.originalName && dn && x.originalName !== dn) return `${dn} ${x.originalName}`;
    return x.originalName ?? dn ?? x.entityId;
  }

  /** Where an entity really is: its own area, otherwise its device's. */
  effectiveArea(id: string): string | undefined {
    const x = this.ents.get(id);
    if (!x) throw new NotFound(`no entity ${id}`);
    if (x.areaId !== undefined) return x.areaId;
    return x.deviceId === undefined ? undefined : this.devs.get(x.deviceId)?.areaId;
  }

  /** Entities in an area (and below it when asked); disabled ones are left out unless requested. */
  entitiesInArea(areaId: string, o: { deep?: boolean; includeDisabled?: boolean; includeHidden?: boolean } = {}): Entity[] {
    if (!this.areas.has(areaId)) throw new NotFound(`no area ${areaId}`);
    const ids = new Set([areaId, ...(o.deep ? this.descendantAreas(areaId).map((a) => a.id) : [])]);
    return [...this.ents.values()].filter((x) => {
      const a = this.effectiveArea(x.id);
      return a !== undefined && ids.has(a) && (o.includeDisabled || !x.disabledBy) && (o.includeHidden || !x.hiddenBy);
    });
  }

  list(o: { domain?: string; platform?: string; deviceId?: string; includeDisabled?: boolean; includeHidden?: boolean } = {}): Entity[] {
    return [...this.ents.values()].filter(
      (x) =>
        (o.domain === undefined || x.entityId.startsWith(`${o.domain}.`)) &&
        (o.platform === undefined || x.platform === o.platform) &&
        (o.deviceId === undefined || x.deviceId === o.deviceId) &&
        (o.includeDisabled || !x.disabledBy) &&
        (o.includeHidden || !x.hiddenBy),
    );
  }

  /** Entities whose integration no longer lists them: pass the unique ids still reported, get the stale ones. */
  orphans(platform: string, stillReported: readonly string[]): Entity[] {
    const keep = new Set(stillReported);
    return [...this.ents.values()].filter((x) => x.platform === platform && !keep.has(x.uniqueId));
  }

  // ------------------------------------------------------------ save and restore

  snapshot(): Snapshot {
    return {
      version: 1,
      configEntries: [...this.entries.values()],
      devices: [...this.devs.values()],
      entities: [...this.ents.values()],
      areas: [...this.areas.values()],
    };
  }

  /** Loads a snapshot, refusing one that points at things that are not in it or repeats an id. */
  static restore(s: Snapshot, o: RegistryOptions): Registry {
    if (s.version !== 1) throw new RegistryError(`unknown snapshot version ${String((s as { version: unknown }).version)}`);
    const r = new Registry(o);
    for (const e of s.configEntries) r.entries.set(e.id, e);
    for (const a of s.areas) r.areas.set(a.id, a);
    for (const d of s.devices) r.devs.set(d.id, d);
    const seen = new Set<string>();
    for (const x of s.entities) {
      if (seen.has(x.entityId)) throw new RegistryError(`entity id ${x.entityId} appears twice`);
      seen.add(x.entityId);
      r.ents.set(x.id, x);
    }
    for (const a of s.areas) if (a.parentId !== undefined && !r.areas.has(a.parentId)) throw new RegistryError(`area ${a.id} has a missing parent`);
    for (const d of s.devices) {
      if (d.areaId !== undefined && !r.areas.has(d.areaId)) throw new RegistryError(`device ${d.id} is in a missing area`);
      for (const c of d.configEntries) if (!r.entries.has(c)) throw new RegistryError(`device ${d.id} has a missing config entry`);
    }
    for (const x of s.entities) if (x.deviceId !== undefined && !r.devs.has(x.deviceId)) throw new RegistryError(`entity ${x.entityId} has a missing device`);
    return r;
  }
}

function mergePairs(a: readonly (readonly [string, string])[], b: readonly (readonly [string, string])[]): (readonly [string, string])[] {
  const out = new Map<string, readonly [string, string]>();
  for (const p of [...a, ...b]) out.set(pairKey(p), p);
  return [...out.values()];
}

function withoutKey<T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> & Partial<Pick<T, K>> {
  const { [k]: _gone, ...rest } = o;
  return rest as Omit<T, K> & Partial<Pick<T, K>>;
}
