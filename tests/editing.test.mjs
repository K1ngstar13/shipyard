import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright';
const root = path.resolve(import.meta.dirname, '..');

test('editable listing survives slow loads and draft reopening; replacement artwork and save-only use Block Pets', {timeout:120000}, async () => {
  const server = http.createServer((req,res) => {
    const file = path.join(root, 'site', new URL(req.url,'http://local').pathname === '/' ? 'index.html' : new URL(req.url,'http://local').pathname);
    try { res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(file)); }
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({...(process.env.SHIPYARD_BROWSER_PATH?{executablePath:process.env.SHIPYARD_BROWSER_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
  const page = await browser.newPage({viewport:{width:1100,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const game = JSON.parse(fs.readFileSync(path.join(root,'games/block-pals/game.json')));game.name='Block Pals';
  const config = JSON.parse(fs.readFileSync(path.join(root,'shipyard.config.json')));
  const blobs=[],trees=[];let dispatched=0,oldFeatureReads=0;
  await page.addInitScript(()=>{if(window===top)localStorage.setItem('shipyard.settings',JSON.stringify({owner:'test',repo:'shipyard',branch:'main',token:'test-private-token'}));});
  await page.route('https://api.github.com/**',async route=>{
    const req=route.request(),u=new URL(req.url()),p=u.pathname;let out={},status=200;
    if(req.method()==='POST'&&p.endsWith('/git/blobs')){blobs.push(req.postDataJSON());out={sha:`blob${blobs.length}`};}
    else if(req.method()==='POST'&&p.endsWith('/git/trees')){trees.push(req.postDataJSON());out={sha:'newtree'};}
    else if(p.includes('/git/ref/'))out={object:{sha:'parent'}};
    else if(p.includes('/git/commits/'))out={tree:{sha:'oldtree'}};
    else if(req.method()==='POST'&&p.endsWith('/git/commits'))out={sha:'newcommit'};
    else if(p.includes('/git/trees/'))out={tree:[{type:'blob',path:'games/block-pals/store/previews/thumbs/feature.jpg'},{type:'blob',path:'games/block-pals/store/screenshots/apple/06.png'}],truncated:false};
    else if(p.endsWith('/dispatches')){dispatched++;status=204;}
    else if(p.includes('/actions/workflows/ship.yml/runs'))out={workflow_runs:[]};
    else if(p.endsWith('/contents/games'))out=[{name:'block-pals',type:'dir',path:'games/block-pals'}];
    else if(p.includes('/contents/')){
      const name=decodeURIComponent(p.split('/contents/')[1]);const file=path.join(root,name);
      if(name==='shipyard.config.json')out={content:Buffer.from(JSON.stringify(config)).toString('base64')};
      else if(name==='games/block-pals/game.json')out={content:Buffer.from(JSON.stringify(game)).toString('base64')};
      else if(name.endsWith('/store/previews/thumbs/feature.jpg')){oldFeatureReads++;out={content:Buffer.from('old feature image').toString('base64')};}
      else if(fs.existsSync(file)&&fs.statSync(file).isDirectory())out=fs.readdirSync(file,{withFileTypes:true}).map(e=>({name:e.name,type:e.isDirectory()?'dir':'file',path:name+'/'+e.name}));
      else if(fs.existsSync(file)){
        if(/\/store\/.*\.txt$/.test(name))await new Promise(resolve=>setTimeout(resolve,400));
        out={content:fs.readFileSync(file).toString('base64')};
      }else {status=404;out={message:'Not Found'};}
    }
    await route.fulfill({status,contentType:'application/json',body:status===204?'':JSON.stringify(out)});
  });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button',{name:/Block Pals/}).click();await page.locator('#editFromShip').click();
    assert.match(await page.locator('#stepLabel').textContent(),/^Step 4/);
    await page.locator('#fName').fill('Block Pets');await page.locator('#fDescription').fill('Block Pets: my own carefully written description.');
    await page.waitForFunction(()=>document.querySelector('#analysis').textContent.includes('Current listing loaded'));
    assert.equal(await page.locator('#fName').inputValue(),'Block Pets');
    assert.equal(await page.locator('#fDescription').inputValue(),'Block Pets: my own carefully written description.');
    await page.locator('#fSubtitle').fill('Puzzle pets');
    await page.locator('[data-go-step="1"]').click();
    await page.locator('#fFiles').setInputFiles(path.join(root,'games/block-pals/www/index.html'));
    await page.waitForFunction(()=>document.querySelector('#analysis').textContent.includes('Reads as'));
    assert.equal(await page.locator('#fName').inputValue(),'Block Pets');
    await page.locator('[data-next="2"]').click();assert.match(await page.locator('#stepLabel').textContent(),/^Step 2/);
    await page.frameLocator('#previewFrame').getByRole('button',{name:'PLAY',exact:true}).waitFor();
    await page.locator('#iconDesign').click();await page.waitForFunction(()=>!document.querySelector('#iconSquare').hidden);
    const selectedIcon=await page.locator('#iconSquare').getAttribute('src');assert(selectedIcon.startsWith('data:image/png;base64,'));
    await page.locator('[data-next="3"]').click();assert.match(await page.locator('#stepLabel').textContent(),/^Step 3/);
    await page.locator('#recordShot').click();await page.waitForFunction(()=>document.querySelectorAll('#shotList img').length===1);
    const selectedShot=await page.locator('#shotList img').getAttribute('src');
    for(const step of [4,5,6,7]) {await page.locator(`[data-next="${step}"]`).click();assert.match(await page.locator('#stepLabel').textContent(),new RegExp('^Step '+step));}
    await page.locator('#previewFeature img').waitFor();if(process.env.SHIPYARD_REVIEW_QA){await page.locator('#wizardSheet .sheet-body').evaluate(el=>el.scrollTop=0);await page.screenshot({path:process.env.SHIPYARD_REVIEW_QA});}assert.equal(await page.locator('#previewFeature img').getAttribute('alt'),'Current store banner for Block Pets');
    assert.deepEqual(await page.locator('#previewThumbs img').evaluateAll(nodes=>nodes.map(node=>node.src)),[selectedShot]);
    await page.locator('#saveDraftBtn').click();await page.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('Draft saved'));
    const snapshot=await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('shipyard.drafts',1);r.onsuccess=()=>{const q=r.result.transaction('drafts').objectStore('drafts').get('test/shipyard/main/block-pals');q.onsuccess=()=>resolve(JSON.stringify(q.result));q.onerror=()=>reject(q.error)};}));
    assert(!snapshot.includes('test-private-token'));
    await page.locator('#wizardSheet [data-close]').click();
    await page.getByRole('button',{name:/Block Pals/}).click();await page.locator('#editFromShip').click();
    await page.waitForFunction(()=>document.querySelector('#draftStatus').textContent.includes('Restored'));
    assert.match(await page.locator('#stepLabel').textContent(),/^Step 4/);
    assert.equal(await page.locator('#fName').inputValue(),'Block Pets');assert.equal(await page.locator('#fSubtitle').inputValue(),'Puzzle pets');
    assert.equal(await page.locator('#fDescription').inputValue(),'Block Pets: my own carefully written description.');
    assert.equal(await page.locator('#iconSquare').getAttribute('src'),selectedIcon);
    await page.locator('[data-go-step="3"]').click();assert.equal(await page.locator('#shotList img').getAttribute('src'),selectedShot);
    await page.locator('[data-go-step="7"]').click();await page.getByRole('button',{name:'Edit Game',exact:true}).click();assert.match(await page.locator('#stepLabel').textContent(),/^Step 4/);
    await page.locator('#fSubtitle').fill('Happy puzzle pets');await page.locator('[data-go-step="7"]').click();
    await page.locator('#saveListingBtn').click();await page.waitForFunction(()=>!document.querySelector('#wizardSheet').open);
    assert.equal(dispatched,0);assert.equal(oldFeatureReads,0);
    const tree=trees.at(-1).tree;const gameEntry=tree.find(e=>e.path==='games/block-pals/game.json');
    const savedGame=JSON.parse(Buffer.from(blobs[Number(gameEntry.sha.slice(4))-1].content,'base64').toString());
    assert.equal(savedGame.name,'Block Pets');assert.equal(savedGame.bundleId,'elevatr.llc.blockpals');
    const subtitle=tree.find(e=>e.path.endsWith('/store/subtitle.txt'));assert.equal(Buffer.from(blobs[Number(subtitle.sha.slice(4))-1].content,'base64').toString().trim(),'Happy puzzle pets');
    assert(tree.some(e=>e.path.endsWith('/previews/thumbs/feature.jpg')&&e.sha===null));
    for(const store of ['apple','google']){const shot=tree.find(e=>e.path.endsWith(`/screenshots/${store}/01.png`));assert.equal(blobs[Number(shot.sha.slice(4))-1].content,selectedShot.split(',')[1]);}
    // A brand-new import also visits every step in order and cannot jump ahead.
    await page.locator('#addBtn').click();assert.match(await page.locator('#stepLabel').textContent(),/^Step 1/);
    assert(await page.locator('[data-go-step="7"]').isDisabled());
    await page.locator('#fFiles').setInputFiles(path.join(root,'games/block-pals/www/index.html'));
    await page.waitForFunction(()=>document.querySelector('#analysis').textContent.includes('Reads as'));
    for(const step of [2,3,4,5,6,7]){await page.locator(`[data-next="${step}"]`).click();assert.match(await page.locator('#stepLabel').textContent(),new RegExp('^Step '+step));}
    await page.locator('#wizardSheet [data-close]').click();
    assert.deepEqual(errors,[]);
  }finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
