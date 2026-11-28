import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conflict, InvalidId, NotFound, Registry, RegistryError, slugify, splitEntityId } from './index.ts';

const make = () => {
  let n = 0;
  let t = 1000;
  return new Registry({ newId: () => `id${++n}`, now: () => ++t });
};

test('slugify folds accents and symbols and never returns an empty id', () => {
  assert.equal(slugify('Kitchen Lamp #2'), 'kitchen_lamp_2');
  assert.equal(slugify('Café Lumière'), 'cafe_lumiere');
  assert.equal(slugify('  ---  '), 'unnamed');
});

test('entity ids must be domain.object_id', () => {
  assert.deepEqual(splitEntityId('light.kitchen_lamp'), { domain: 'light', objectId: 'kitchen_lamp' });
  for (const bad of ['light', 'Light.x', 'light.', '.x', 'light.a.b', 'light.Bad', '']) assert.throws(() => splitEntityId(bad), InvalidId);
});

test('the same platform and unique id is the same entity, and a name clash gets a number', () => {
  const r = make();
  const a = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'u1', originalName: 'Lamp' });
  const again = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'u1', originalName: 'Different' });
  assert.equal(again.id, a.id);
  assert.equal(a.entityId, 'light.lamp');
  const b = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'u2', originalName: 'Lamp' });
  const c = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'u3', originalName: 'Lamp' });
  assert.equal(b.entityId, 'light.lamp_2');
  assert.equal(c.entityId, 'light.lamp_3');
  const sw = r.getOrCreateEntity({ domain: 'switch', platform: 'hue', uniqueId: 'u1', originalName: 'Lamp' });
  assert.notEqual(sw.id, a.id, 'same unique id in another domain is another entity');
});

test('a rename keeps the internal id, refuses a taken id or a changed domain, and the old id still finds it', () => {
  const r = make();
  const a = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'u1', originalName: 'Lamp' });
  r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'u2', originalName: 'Desk' });
  const renamed = r.renameEntityId(a.id, 'light.reading_lamp');
  assert.equal(renamed.id, a.id);
  assert.equal(r.get('light.reading_lamp')?.id, a.id);
  assert.equal(r.get('light.lamp')?.id, a.id, 'old id resolves');
  assert.throws(() => r.renameEntityId(a.id, 'light.desk'), /already used/);
  assert.throws(() => r.renameEntityId(a.id, 'switch.reading_lamp'), /domain cannot change/);
  assert.deepEqual(r.getById(a.id)?.previousEntityIds, ['light.lamp']);
  const back = r.renameEntityId(a.id, 'light.lamp');
  assert.deepEqual(back.previousEntityIds, ['light.reading_lamp']);
});

test('a freed entity id can be taken by a new entity, and the old alias does not steal it', () => {
  const r = make();
  const a = r.getOrCreateEntity({ domain: 'light', platform: 'p', uniqueId: 'a', originalName: 'Lamp' });
  r.renameEntityId(a.id, 'light.old_lamp');
  const b = r.getOrCreateEntity({ domain: 'light', platform: 'p', uniqueId: 'b', originalName: 'Lamp' });
  assert.equal(b.entityId, 'light.lamp');
  assert.equal(r.get('light.lamp')?.id, b.id, 'a live id beats an alias');
});

test('devices with a shared identifier or connection are one device, merged', () => {
  const r = make();
  const e1 = r.addConfigEntry('hue', 'Hue bridge');
  const e2 = r.addConfigEntry('matter', 'Matter');
  const d1 = r.getOrCreateDevice({ configEntryId: e1.id, identifiers: [['hue', 'abc']], name: 'Bulb' });
  const d2 = r.getOrCreateDevice({ configEntryId: e2.id, connections: [['mac', 'AA:BB']], identifiers: [['hue', 'ABC']], name: 'Bulb' });
  assert.equal(d2.id, d1.id);
  assert.deepEqual(d2.configEntries, [e1.id, e2.id]);
  const d3 = r.getOrCreateDevice({ configEntryId: e2.id, connections: [['mac', 'aa:bb']], name: 'Bulb' });
  assert.equal(d3.id, d1.id, 'connections compare without case');
  assert.equal(d3.identifiers.length, 1);
  assert.throws(() => r.getOrCreateDevice({ configEntryId: e1.id, name: 'x' }), InvalidId);
  assert.throws(() => r.getOrCreateDevice({ configEntryId: 'nope', identifiers: [['x', '1']], name: 'x' }), NotFound);
});

test('the area tree refuses loops and duplicate names, and removal lifts the children', () => {
  const r = make();
  const house = r.addArea('House');
  const ground = r.addArea('Ground floor', { parentId: house.id });
  const kitchen = r.addArea('Kitchen', { parentId: ground.id, aliases: ['Cook room'] });
  assert.deepEqual(r.areaPath(kitchen.id), ['House', 'Ground floor', 'Kitchen']);
  assert.throws(() => r.moveArea(house.id, kitchen.id), /inside itself/);
  assert.throws(() => r.moveArea(house.id, house.id), /inside itself/);
  assert.throws(() => r.addArea('kitchen', { parentId: ground.id }), Conflict);
  r.addArea('Kitchen', { parentId: house.id });
  assert.deepEqual(r.descendantAreas(house.id).map((a) => a.name).sort(), ['Ground floor', 'Kitchen', 'Kitchen']);
  assert.equal(r.findArea('cook ROOM')?.id, kitchen.id);
  r.removeArea(ground.id);
  assert.equal(r.area(kitchen.id)?.parentId, house.id);
  assert.throws(() => r.areaPath(ground.id), NotFound);
});

test('an entity is in its own area, otherwise its device area', () => {
  const r = make();
  const kitchen = r.addArea('Kitchen');
  const hall = r.addArea('Hall');
  const entry = r.addConfigEntry('hue', 'Hue');
  const dev = r.getOrCreateDevice({ configEntryId: entry.id, identifiers: [['hue', '1']], name: 'Strip' });
  r.setDeviceArea(dev.id, kitchen.id);
  const a = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'a', deviceId: dev.id, originalName: 'Strip' });
  const b = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'b', deviceId: dev.id, originalName: 'Strip 2' });
  r.updateEntity(b.id, { areaId: hall.id });
  assert.equal(r.effectiveArea(a.id), kitchen.id);
  assert.equal(r.effectiveArea(b.id), hall.id);
  assert.deepEqual(r.entitiesInArea(kitchen.id).map((x) => x.id), [a.id]);
  r.removeArea(hall.id);
  assert.equal(r.effectiveArea(b.id), kitchen.id, 'falls back to the device area when its own area is removed');
  assert.throws(() => r.updateEntity(a.id, { areaId: 'missing' }), NotFound);
});

test('entities in an area can include child areas, and hide disabled and hidden ones by default', () => {
  const r = make();
  const house = r.addArea('House');
  const room = r.addArea('Room', { parentId: house.id });
  const a = r.getOrCreateEntity({ domain: 'light', platform: 'p', uniqueId: 'a', originalName: 'A' });
  const b = r.getOrCreateEntity({ domain: 'light', platform: 'p', uniqueId: 'b', originalName: 'B' });
  const c = r.getOrCreateEntity({ domain: 'light', platform: 'p', uniqueId: 'c', originalName: 'C' });
  for (const x of [a, b, c]) r.updateEntity(x.id, { areaId: room.id });
  r.setEntityDisabled(b.id, true);
  r.updateEntity(c.id, { hiddenBy: 'user' });
  assert.equal(r.entitiesInArea(house.id).length, 0, 'not deep: nothing is directly in the house');
  assert.deepEqual(r.entitiesInArea(house.id, { deep: true }).map((x) => x.id), [a.id]);
  assert.equal(r.entitiesInArea(house.id, { deep: true, includeDisabled: true, includeHidden: true }).length, 3);
});

test('disabling a device switches off its entities, and enabling restores only those it switched off', () => {
  const r = make();
  const entry = r.addConfigEntry('hue', 'Hue');
  const dev = r.getOrCreateDevice({ configEntryId: entry.id, identifiers: [['hue', '1']], name: 'Strip' });
  const a = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'a', deviceId: dev.id, originalName: 'A' });
  const b = r.getOrCreateEntity({ domain: 'sensor', platform: 'hue', uniqueId: 'b', deviceId: dev.id, originalName: 'B' });
  r.setEntityDisabled(b.id, true, 'integration');
  r.setDeviceDisabled(dev.id, true);
  assert.equal(r.getById(a.id)?.disabledBy, 'device');
  assert.equal(r.getById(b.id)?.disabledBy, 'integration', 'already off for its own reason');
  assert.equal(r.list().length, 0);
  assert.throws(() => r.setEntityDisabled(a.id, false), /its device is off/);
  const late = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'late', deviceId: dev.id, originalName: 'Late' });
  assert.equal(late.disabledBy, 'device', 'a new entity of a disabled device starts disabled');
  r.setDeviceDisabled(dev.id, false);
  assert.equal(r.getById(a.id)?.disabledBy, undefined);
  assert.equal(r.getById(b.id)?.disabledBy, 'integration');
  assert.deepEqual(r.list().map((x) => x.id), [a.id, late.id]);
});

test('switching an integration off and on touches only what it switched off', () => {
  const r = make();
  const entry = r.addConfigEntry('hue', 'Hue');
  const a = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'a', configEntryId: entry.id, originalName: 'A' });
  const b = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'b', configEntryId: entry.id, originalName: 'B' });
  r.setEntityDisabled(b.id, true);
  r.setConfigEntryDisabled(entry.id, true);
  assert.equal(r.getById(a.id)?.disabledBy, 'config_entry');
  assert.equal(r.getById(b.id)?.disabledBy, 'user');
  r.setConfigEntryDisabled(entry.id, false);
  assert.equal(r.getById(a.id)?.disabledBy, undefined);
  assert.equal(r.getById(b.id)?.disabledBy, 'user');
});

test('removing a config entry removes its entities and the devices no other integration holds', () => {
  const r = make();
  const e1 = r.addConfigEntry('hue', 'Hue');
  const e2 = r.addConfigEntry('matter', 'Matter');
  const only = r.getOrCreateDevice({ configEntryId: e1.id, identifiers: [['hue', '1']], name: 'Only hue' });
  const shared = r.getOrCreateDevice({ configEntryId: e1.id, identifiers: [['hue', '2']], name: 'Shared' });
  r.getOrCreateDevice({ configEntryId: e2.id, identifiers: [['hue', '2']], name: 'Shared' });
  const child = r.getOrCreateDevice({ configEntryId: e2.id, identifiers: [['matter', 'c']], name: 'Child', viaDeviceId: only.id });
  r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'a', deviceId: only.id, originalName: 'A' });
  r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'b', deviceId: shared.id, originalName: 'B' });
  r.getOrCreateEntity({ domain: 'sensor', platform: 'hue', uniqueId: 'c', configEntryId: e1.id, originalName: 'C' });
  const gone = r.removeConfigEntry(e1.id);
  assert.deepEqual(gone.devices, [only.id]);
  assert.deepEqual(gone.entities.sort(), ['light.a', 'sensor.c']);
  assert.deepEqual(r.device(shared.id)?.configEntries, [e2.id]);
  assert.equal(r.device(child.id)?.viaDeviceId, undefined);
  assert.equal(r.get('light.b')?.entityId, 'light.b');
  assert.throws(() => r.removeConfigEntry(e1.id), NotFound);
});

test('friendly names prefer the user, then the integration, then the device with the entity name', () => {
  const r = make();
  const entry = r.addConfigEntry('hue', 'Hue');
  const dev = r.getOrCreateDevice({ configEntryId: entry.id, identifiers: [['hue', '1']], name: 'Hall strip' });
  const a = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'a', deviceId: dev.id, originalName: 'Brightness' });
  assert.equal(r.friendlyName(a.id), 'Hall strip Brightness');
  r.renameDevice(dev.id, 'Landing strip');
  assert.equal(r.friendlyName(a.id), 'Landing strip Brightness');
  r.updateEntity(a.id, { name: 'Landing light' });
  assert.equal(r.friendlyName(a.id), 'Landing light');
});

test('orphans are the entities an integration no longer reports', () => {
  const r = make();
  r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'a', originalName: 'A' });
  const b = r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'b', originalName: 'B' });
  r.getOrCreateEntity({ domain: 'light', platform: 'other', uniqueId: 'z', originalName: 'Z' });
  assert.deepEqual(r.orphans('hue', ['a']).map((x) => x.id), [b.id]);
});

test('a snapshot restores to the same registry, and a damaged one is refused', () => {
  const r = make();
  const area = r.addArea('Kitchen');
  const entry = r.addConfigEntry('hue', 'Hue');
  const dev = r.getOrCreateDevice({ configEntryId: entry.id, identifiers: [['hue', '1']], name: 'Strip' });
  r.setDeviceArea(dev.id, area.id);
  r.getOrCreateEntity({ domain: 'light', platform: 'hue', uniqueId: 'a', deviceId: dev.id, originalName: 'A' });
  const snap = JSON.parse(JSON.stringify(r.snapshot()));
  const back = Registry.restore(snap, { newId: () => 'x' });
  assert.deepEqual(back.snapshot(), r.snapshot());
  assert.throws(() => Registry.restore({ ...snap, entities: [...snap.entities, snap.entities[0]] }, { newId: () => 'x' }), /appears twice/);
  assert.throws(() => Registry.restore({ ...snap, devices: [] }, { newId: () => 'x' }), /missing device/);
  assert.throws(() => Registry.restore({ ...snap, version: 2 }, { newId: () => 'x' }), RegistryError);
});

test('hostile names and ids do not reach the prototype', () => {
  const r = make();
  const e = r.getOrCreateEntity({ domain: 'light', platform: '__proto__', uniqueId: 'constructor', originalName: '__proto__' });
  assert.equal(e.entityId, 'light.proto');
  assert.equal(r.get('light.proto')?.id, e.id);
  assert.equal(r.get('light.constructor'), undefined);
  assert.throws(() => r.addConfigEntry('Bad Domain', 't'), InvalidId);
  assert.throws(() => r.getOrCreateEntity({ domain: 'Light', platform: 'p', uniqueId: 'a' }), InvalidId);
  assert.throws(() => r.getOrCreateEntity({ domain: 'light', platform: 'p', uniqueId: '' }), InvalidId);
});
