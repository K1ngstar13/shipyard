import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import { chromium } from 'playwright';
import sharp from 'sharp';
const root=path.resolve(import.meta.dirname,'..');

test('recorded Block Pals PNGs win over old previews and persist in both store folders', {timeout:120000}, async()=>{
 const server=http.createServer((req,res)=>{const pathname=new URL(req.url,'http://local').pathname;const file=path.join(root,'site',pathname==='/'?'index.html':pathname);try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({...(process.env.SHIPYARD_BROWSER_PATH?{executablePath:process.env.SHIPYARD_BROWSER_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1000,height:900}});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const game=JSON.parse(fs.readFileSync(path.join(root,'games/block-pals/game.json'))); game.name='Block Pals';
 const config=JSON.parse(fs.readFileSync(path.join(root,'shipyard.config.json')));
 const blobs=[],trees=[];let oldPreviewReads=0;
 await page.addInitScript(()=>{if(window===top)localStorage.setItem('shipyard.settings',JSON.stringify({owner:'test',repo:'shipyard',branch:'main',token:'test-only-token'}));});
 await page.route('https://api.github.com/**',async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname;
  let out={};
  if(req.method()==='POST'&&p.endsWith('/git/blobs')){const body=req.postDataJSON();blobs.push(body);out={sha:`blob${blobs.length}`};}
  else if(req.method()==='POST'&&p.endsWith('/git/trees')){trees.push(req.postDataJSON());out={sha:'newtree'};}
  else if(p.includes('/git/ref/'))out={object:{sha:'parent'}};
  else if(p.includes('/git/commits/'))out={tree:{sha:'oldtree'}};
  else if(req.method()==='POST'&&p.endsWith('/git/commits'))out={sha:'newcommit'};
  else if(p.includes('/git/trees/'))out={tree:[{type:'blob',path:'games/block-pals/store/screenshots/apple/06.png'},{type:'blob',path:'games/block-pals/store/screenshots/google/06.png'}],truncated:false};
  else if(p.includes('/actions/workflows/ship.yml/runs'))out={workflow_runs:[]};
  else if(p.endsWith('/contents/games'))out=[{name:'block-pals',type:'dir'}];
  else if(p.endsWith('/contents/games/block-pals/store/previews/thumbs')){oldPreviewReads++;out=[{name:'apple-01.jpg',path:'old-preview.jpg'}];}
  else if(p.includes('/contents/')){
   const name=decodeURIComponent(p.split('/contents/')[1]);
   if(name==='shipyard.config.json')out={content:Buffer.from(JSON.stringify(config)).toString('base64')};
   else if(name==='games/block-pals/game.json')out={content:Buffer.from(JSON.stringify(game)).toString('base64')};
   else if(name==='old-preview.jpg')out={content:Buffer.from('OLD_IMAGE').toString('base64')};
   else {const f=path.join(root,name);if(fs.existsSync(f)&&fs.statSync(f).isDirectory())out=fs.readdirSync(f,{withFileTypes:true}).map(entry=>({name:entry.name,type:entry.isDirectory()?'dir':'file',path:name+'/'+entry.name}));else out={content:fs.existsSync(f)?fs.readFileSync(f).toString('base64'):''};}
  }
  await route.fulfill({status:p.endsWith('/dispatches')?204:200,contentType:'application/json',body:p.endsWith('/dispatches')?'':JSON.stringify(out)});
 });
 try{
  await page.goto(base);await page.getByRole('button',{name:/Block Pals/}).click();await page.locator('#editFromShip').click();await page.locator('[data-go-step="1"]').click();
  await page.locator('#fFiles').setInputFiles(path.join(root,'games/block-pals/www/index.html'));
  await page.waitForFunction(()=>document.querySelector('#analysis').textContent.includes('Reads as'));
  await page.locator('[data-next="2"]').click();
  await page.waitForFunction(()=>document.querySelector('#previewFrame').src.startsWith('data:text/html'));
  const frame=page.frameLocator('#previewFrame');await frame.getByRole('button',{name:'PLAY',exact:true}).waitFor();
  await page.locator('[data-next="3"]').click();await page.locator('#recordShot').click();
  await page.waitForFunction(()=>document.querySelectorAll('#shotList img').length===1);
  const first=await page.locator('#shotList img').getAttribute('src');assert(first.startsWith('data:image/png;base64,'));
  const meta=await sharp(Buffer.from(first.split(',')[1],'base64')).metadata();assert.equal(meta.width,1290);assert.equal(meta.height,2796);
  await frame.getByRole('button',{name:'PLAY',exact:true}).click();
  await frame.locator('#lvGrid .lv').first().evaluate(button=>button.click());
  await frame.locator('#cv').waitFor();
  const gameFramePlaying=page.frames().find(f=>f.url().startsWith('data:text/html'));
  await gameFramePlaying.evaluate(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'1'}));window.dispatchEvent(new KeyboardEvent('keydown',{key:' '}));});
  await page.waitForTimeout(500);
  await page.locator('#recordShot').click();await page.waitForFunction(()=>document.querySelectorAll('#shotList img').length===2);
  const second=await page.locator('#shotList img').nth(1).getAttribute('src');assert.notEqual(first,second);
  if(process.env.SHIPYARD_CAPTURE_OUTPUT)fs.writeFileSync(process.env.SHIPYARD_CAPTURE_OUTPUT,Buffer.from(second.split(',')[1],'base64'));
  // Game cannot see the panel's GitHub token despite renderer clone access.
  const gameFrame=page.frames().find(f=>f.url().startsWith('data:text/html'));
  assert.equal(await gameFrame.evaluate(()=>{try{return parent.localStorage.getItem('shipyard.settings')}catch{return 'blocked'}}),'blocked');
  const oldReadsBeforeReview=oldPreviewReads;
  for(const step of [4,5,6,7])await page.locator(`[data-next="${step}"]`).click();
  const review=await page.locator('#previewThumbs img').evaluateAll(nodes=>nodes.map(n=>n.src));assert.deepEqual(review,[first,second]);assert.equal(oldPreviewReads,oldReadsBeforeReview);
  await page.locator('[data-back="6"]').click();await page.locator('[data-back="5"]').click();await page.locator('[data-back="4"]').click();await page.locator('[data-back="3"]').click();
  await page.locator('#shotList [data-drop="0"]').click();
  for(const step of [4,5,6,7])await page.locator(`[data-next="${step}"]`).click();
  assert.deepEqual(await page.locator('#previewThumbs img').evaluateAll(nodes=>nodes.map(n=>n.src)),[second]);
  await page.locator('#submitBtn').click();await page.waitForFunction(()=>!document.querySelector('#wizardSheet').open);
  const tree=trees.at(-1).tree;const shots=tree.filter(e=>e.path.includes('/store/screenshots/')&&e.sha);
  assert.deepEqual(shots.map(s=>s.path),['games/block-pals/store/screenshots/apple/01.png','games/block-pals/store/screenshots/google/01.png']);
  for(const shot of shots)assert.equal(blobs[Number(shot.sha.slice(4))-1].content,second.split(',')[1]);
  assert(tree.some(e=>e.path.endsWith('/apple/06.png')&&e.sha===null));assert(tree.some(e=>e.path.endsWith('/google/06.png')&&e.sha===null));
  // The store build consumes the exact recorded PNG, not a fresh menu screenshot.
  const fixture=path.join(root,'games','recorded-shot-test');
  try{
   fs.mkdirSync(fixture,{recursive:true});fs.copyFileSync(path.join(root,'games/block-pals/game.json'),path.join(fixture,'game.json'));fs.copyFileSync(path.join(root,'games/block-pals/icon.png'),path.join(fixture,'icon.png'));
   for(const store of ['apple','google']){const dir=path.join(fixture,'store/screenshots',store);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'01.png'),Buffer.from(second.split(',')[1],'base64'));}
   execFileSync(process.execPath,['scripts/store-assets.mjs','recorded-shot-test'],{cwd:root});
   const pixels=await sharp(Buffer.from(second.split(',')[1],'base64')).flatten({background:game.backgroundColor}).removeAlpha().raw().toBuffer();
   for(const dest of ['apple/screenshots/en-US/1_iphone.png','google/en-US/images/phoneScreenshots/1_en-US.png'])assert.deepEqual(await sharp(path.join(root,'build/recorded-shot-test/store',dest)).raw().toBuffer(),pixels);
  }finally{fs.rmSync(fixture,{recursive:true,force:true});fs.rmSync(path.join(root,'build/recorded-shot-test'),{recursive:true,force:true});}
  assert.deepEqual(errors,[]);
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
