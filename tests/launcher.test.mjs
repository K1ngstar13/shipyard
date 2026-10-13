import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {stopPreviousShipyards} from '../scripts/start.mjs';
import {createShipyardServer, listenAvailable} from '../scripts/serve.mjs';

test('restart targets verified Shipyard processes and old TTYs while unrelated work and the current launcher survive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-restart-'));
  try {
    const shipyard = path.join(root,'shipyard'), other = path.join(root,'another-project');
    for (const [dir,name] of [[shipyard,'shipyard'],[other,'another-project']]) {fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name}));}
    const old = {pid:10001,ppid:10002,tty:'ttys011',command:'node scripts/serve.mjs'};
    const unrelated = {pid:10003,ppid:10004,tty:'ttys012',command:'node scripts/serve.mjs'};
    const current = {pid:process.pid,ppid:process.ppid,tty:'ttys013',command:'node scripts/serve.mjs'};
    const rows=[old,unrelated,current]; const alive=new Set(rows.map(row=>row.pid)); const signals=[],closed=[];
    const stopped=await stopPreviousShipyards({
      inventory:()=>rows.filter(row=>alive.has(row.pid)),resolveCwd:pid=>pid===unrelated.pid?other:shipyard,
      kill:(pid,signal)=>{if(!alive.has(pid))throw new Error('gone');if(signal){signals.push([pid,signal]);alive.delete(pid);}},
      wait:async()=>{},terminalCloser:ttys=>closed.push(...ttys),
    });
    assert.deepEqual(stopped,[old.pid]);assert.deepEqual(signals,[[old.pid,'SIGTERM']]);assert.deepEqual(closed,['ttys011']);
    assert(alive.has(unrelated.pid));assert(alive.has(current.pid));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('occupied port opens a new versioned server and rejects path traversal', async () => {
  const other = http.createServer((req,res) => res.end('another app'));
  await new Promise(resolve => other.listen(0,'127.0.0.1',resolve));
  const shipyard = createShipyardServer();
  try {
    const port = await listenAvailable(shipyard, other.address().port);
    assert.notEqual(port, other.address().port);
    const health = await fetch(`http://127.0.0.1:${port}/__shipyard`);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal((await health.json()).version, '2.4.0');
    const traversal = await fetch(`http://127.0.0.1:${port}/..%2fpackage.json`); assert.equal(traversal.status,403);
  } finally { await Promise.all([new Promise(r => other.close(r)), new Promise(r => shipyard.close(r))]); }
});
