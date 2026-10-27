// Parity tests: level travel (UGameEngine ExportTravel / ULevel::SpawnPlayActor) and travel URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick } from './helpers.mjs';

test('ExportTravel: the player and its bTravel inventory, non-default travel properties, actor references by name', async () => {
  const e = await engine('Lev2_Inc_B'); tick(e, 0.5);
  const p = e.player;
  p.numBeans = 7;
  const recs = e.exportTravel();
  assert.equal(recs[0].name, p.Name);
  assert.equal(recs[0].props.numBeans, 7);
  assert.ok(!('numStars' in recs[0].props), 'default values are not exported');
  assert.deepEqual(recs[0].props.Weapon, { __actor: p.Weapon.Name });
  assert.ok(recs.some(r => r.name === p.Weapon.Name && r.cls === 'baseWand'));
  p.Weapon.bTravel = false;
  assert.ok(!e.exportTravel().some(r => r.cls === 'baseWand'), 'bTravel off: stays behind');
  p.Weapon.bTravel = true;
  e.restoreConsole();
});

test('SpawnPlayActor: TravelPreAccept on the player, items spawned and linked, reverse PreAccept, AcceptInventory, reverse PostAccept, player PostAccept, PostLogin', async () => {
  const e = await engine('Lev2_Inc_B'); tick(e, 0.5);
  e.player.numBeans = 9;
  const recs = e.exportTravel();
  e.restoreConsole();
  const order = [];
  const e2 = await engine(null);
  const orig = e2.vm.event.bind(e2.vm);
  e2.vm.event = (o, n, ...a) => {
    if (/^(TravelPreAccept|TravelPostAccept|AcceptInventory|PostLogin)$/.test(n)) order.push(n + ':' + (o?.Class?.isA('PlayerPawn') ? 'P' : o?.Class?.isA('GameInfo') ? 'G' : o?.Class?.name));
    return orig(o, n, ...a);
  };
  await e2.loadMap('Lev2_Inc_B', '', recs);
  e2.vm.event = orig;
  assert.deepEqual(order, ['TravelPreAccept:P', 'TravelPreAccept:baseWand', 'TravelPreAccept:P', 'AcceptInventory:G', 'TravelPostAccept:baseWand', 'TravelPostAccept:P', 'TravelPostAccept:P', 'PostLogin:G']);
  const p = e2.player;
  assert.equal(p.numBeans, 9);
  assert.equal(p.Weapon.Owner, p, 'Weapon is the travelled wand, given to the player');
  assert.notEqual(p.Weapon.Name, recs[1].name);
  e2.restoreConsole();
});

test('travel URLs: options-only is relative to the map; ?restart re-enters with the incoming travel data; #portal goes to Login', async () => {
  const e = await engine('Lev2_Inc_B'); tick(e, 0.5);
  e.level.travelInfo = [{ cls: 'Harry', name: 'x', props: { numBeans: 3 } }];
  e.travel('?restart', true);
  assert.equal(e.pendingTravel.map, 'Lev2_Inc_B');
  assert.equal(e.pendingTravel.travel, e.level.travelInfo);
  e.travel('Lev_Tut1.unr#Gate?Name=x', true);
  assert.equal(e.pendingTravel.map, 'Lev_Tut1');
  assert.equal(e.pendingTravel.options, '#Gate?Name=x');
  let portal = null;
  const orig = e.vm.event.bind(e.vm);
  e.vm.event = (o, n, ...a) => { if (n === 'Login') portal = a[0]; return orig(o, n, ...a); };
  await e.loadMap('Lev2_Inc_B', '#Gate?Name=x');
  e.vm.event = orig;
  assert.equal(portal, 'Gate');
  e.restoreConsole();
});
