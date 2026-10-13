import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright';
const root = path.resolve(import.meta.dirname, '..');

// The panel against a mocked GitHub and a mocked App Store search.
async function openPanel({ taken = {}, releases = {} } = {}) {
  const server = http.createServer((req,res) => {
    const file = path.join(root, 'site', new URL(req.url,'http://local').pathname === '/' ? 'index.html' : new URL(req.url,'http://local').pathname);
    try { res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(file)); }
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({...(process.env.SHIPYARD_BROWSER_PATH?{executablePath:process.env.SHIPYARD_BROWSER_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
  const page = await browser.newPage({viewport:{width:1100,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const blobs=[],trees=[],dispatches=[],searches=[];
  await page.addInitScript(()=>{if(window===top)localStorage.setItem('shipyard.settings',JSON.stringify({owner:'test',repo:'shipyard',branch:'main',token:'test-private-token'}));});
  await page.route('https://itunes.apple.com/**',async route=>{
    const u=new URL(route.request().url());const term=u.searchParams.get('term');searches.push(term);
    const results=taken[term]?[{trackName:term,sellerName:taken[term],bundleId:'com.other.app',trackViewUrl:'https://apps.apple.com/app/id1'}]:[];
    await route.fulfill({contentType:'text/javascript',body:`${u.searchParams.get('callback')}(${JSON.stringify({resultCount:results.length,results})});`});
  });
  await page.route('https://api.github.com/**',async route=>{
    const req=route.request(),p=new URL(req.url()).pathname;let out={},status=200;
    if(req.method()==='POST'&&p.endsWith('/git/blobs')){blobs.push(req.postDataJSON());out={sha:`blob${blobs.length}`};}
    else if(req.method()==='POST'&&p.endsWith('/git/trees')){trees.push(req.postDataJSON());out={sha:'newtree'};}
    else if(p.includes('/git/ref/'))out={object:{sha:'parent'}};
    else if(p.includes('/git/commits/'))out={tree:{sha:'oldtree'}};
    else if(req.method()==='POST'&&p.endsWith('/git/commits'))out={sha:'newcommit'};
    else if(p.includes('/git/trees/'))out={tree:[],truncated:false};
    else if(p.endsWith('/dispatches')){dispatches.push([p,req.postDataJSON()]);status=204;}
    else if(p.includes('/actions/workflows/ship.yml/runs'))out={workflow_runs:[]};
    else if(p.includes('/contents/')){
      const name=decodeURIComponent(p.split('/contents/')[1]);const file=path.join(root,name);
      const slug=(name.match(/^games\/([^/]+)\/release\.json$/)||[])[1];
      if(slug&&slug in releases)out={content:Buffer.from(JSON.stringify(releases[slug])).toString('base64')};
      else if(fs.existsSync(file)&&fs.statSync(file).isDirectory())out=fs.readdirSync(file,{withFileTypes:true}).map(e=>({name:e.name,type:e.isDirectory()?'dir':'file',path:name+'/'+e.name}));
      else if(fs.existsSync(file))out={content:fs.readFileSync(file).toString('base64')};
      else {status=404;out={message:'Not Found'};}
    }
    await route.fulfill({status,contentType:'application/json',body:status===204?'':JSON.stringify(out)});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const savedFile=(suffix)=>{const tree=trees.at(-1).tree;const e=tree.find(x=>x.path.endsWith(suffix));return Buffer.from(blobs[Number(e.sha.slice(4))-1].content,'base64').toString();};
  const close=async()=>{await browser.close();await new Promise(r=>server.close(r));};
  return {page,errors,dispatches,searches,savedFile,close};
}

test('new import: a taken App Store name is caught, free alternatives offered, and the App ID and home-screen name follow', {timeout:120000}, async () => {
  const ctx = await openPanel({ taken: { 'Block Pets': 'Other Studio' } });
  const {page} = ctx;
  try {
    await page.locator('#addBtn').click();
    await page.locator('#fFiles').setInputFiles(path.join(root,'games/block-pals/www/index.html'));
    await page.waitForFunction(()=>document.querySelector('#analysis').textContent.includes('Reads as'));
    assert.equal(await page.locator('#fBundle').inputValue(),'elevatr.llc.blockpets','the App ID is generated from the name on import');
    for(const step of [2,3,4]) await page.locator(`[data-next="${step}"]`).click();
    await page.waitForFunction(()=>document.querySelector('#nameCheck').classList.contains('taken'));
    assert.match(await page.locator('#nameCheck').textContent(),/“Block Pets” is already Other Studio’s app/);
    await page.locator('[data-next="5"]').click();
    assert.match(await page.locator('#wizardErrors').textContent(),/already used by another App Store app/);
    assert.match(await page.locator('#stepLabel').textContent(),/^Step 4/,'cannot continue with a taken name');
    const idea = page.locator('[data-name-idea]').first();await idea.waitFor();
    const chosen = await idea.textContent();
    await idea.click();
    await page.waitForFunction(()=>document.querySelector('#nameCheck').classList.contains('free'));
    assert.equal(await page.locator('#fName').inputValue(),chosen);
    const expectedBundle='elevatr.llc.'+chosen.toLowerCase().replace(/[^a-z0-9]/g,'');
    assert.equal(await page.locator('#fBundle').inputValue(),expectedBundle);
    assert.equal(await page.locator('#fDisplay').inputValue(),chosen.length<=12?chosen:'Block Pets');
    assert.match(await page.locator('#fDescription').inputValue(),new RegExp(chosen.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),'listing text is renamed with the game');
    await page.locator('#fDisplay').fill('Pets');
    await page.locator('#fName').fill('Block Pets Party');
    assert.equal(await page.locator('#fDisplay').inputValue(),'Pets','a home-screen name you typed stays put');
    assert.equal(await page.locator('#fBundle').inputValue(),'elevatr.llc.blockpetsparty');
    await page.locator('#fDisplay').fill('');
    assert.equal(await page.locator('#fDisplay').inputValue(),'Block Pets Party','clearing it follows the name again');
    assert.deepEqual(ctx.errors,[]);
  } finally { await ctx.close(); }
});

test('existing game: the locked App ID cannot change, renaming keeps it, and TestFlight status is shown with Check now', {timeout:120000}, async () => {
  const release = JSON.parse(fs.readFileSync(path.join(root,'games/block-pals/release.json')));
  release.testflight = {...release.testflight, state:'ready', label:'Build 101 is in Elevatr Internal Testing with no testers', next:{title:'Add yourself to Elevatr Internal Testing', detail:'Internal testers must be users on your team.', url:'https://appstoreconnect.apple.com/apps/6821781861/testflight/ios', blocking:true}};
  const ctx = await openPanel({ releases: { 'block-pals': release, quackdoku: {} } });
  const {page} = ctx;
  try {
    const row = page.getByRole('button',{name:/Block Pets/});
    await row.waitFor();
    assert.match(await row.textContent(),/Build 101 is in Elevatr Internal Testing with no testers\. Add yourself/);
    await row.click();
    const card = page.locator('#shipStatus');
    assert.match(await card.textContent(),/Next step: Add yourself to Elevatr Internal Testing/);
    assert.match(await card.textContent(),/App ID elevatr\.llc\.blockpals is locked/);
    await page.locator('#checkTestflight').click();
    await page.waitForFunction(()=>document.querySelector('#checkTestflight').textContent==='Asking Apple…');
    assert.match(ctx.dispatches.at(-1)[0],/testflight-status\.yml\/dispatches$/);
    assert.deepEqual(ctx.dispatches.at(-1)[1].inputs,{game:'block-pals'});
    await page.locator('#editFromShip').click();
    await page.waitForFunction(()=>document.querySelector('#analysis').textContent.includes('Current listing loaded'));
    await page.locator('#fName').fill('Block Pets World');
    await page.waitForFunction(()=>document.querySelector('#nameCheck').classList.contains('free'));
    assert.match(await page.locator('#nameCheck').textContent(),/the App ID stays elevatr\.llc\.blockpals/);
    await page.locator('[data-go-step="6"]').click();
    assert.equal(await page.locator('#fBundle').inputValue(),'elevatr.llc.blockpals');
    assert(await page.locator('#fBundle').evaluate(el=>el.readOnly));
    assert.match(await page.locator('#bundleNote').textContent(),/^🔒 Locked\. Build 101 was uploaded/);
    await page.locator('[data-go-step="7"]').click();
    assert.match(await page.locator('#reviewSummary').textContent(),/elevatr\.llc\.blockpals \(locked\)/);
    await page.locator('#saveListingBtn').click();await page.waitForFunction(()=>!document.querySelector('#wizardSheet').open);
    const saved = JSON.parse(ctx.savedFile('/game.json'));
    assert.equal(saved.name,'Block Pets World');assert.equal(saved.bundleId,'elevatr.llc.blockpals');
    assert.equal(saved.displayName,'Block Pets World');assert(!('release' in saved),'release.json stays separate from game.json');

    // QuackDoku has no App Store Connect record, so its App ID still follows a rename.
    await page.getByRole('button',{name:/QuackDoku/}).click();await page.locator('#editFromShip').click();
    await page.waitForFunction(()=>document.querySelector('#analysis').textContent.includes('Current listing loaded'));
    await page.locator('#fName').fill('Quack Sudoku');
    assert.equal(await page.locator('#fBundle').inputValue(),'elevatr.llc.quacksudoku');
    assert.equal(await page.locator('#fDisplay').inputValue(),'Quack Sudoku');
    assert.deepEqual(ctx.errors,[]);
  } finally { await ctx.close(); }
});
