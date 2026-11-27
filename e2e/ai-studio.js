const { openLegacy } = require("./legacy-production");
// API requests are intercepted; synthetic fixture and fake key never leave the browser.
const { chromium } = require('playwright');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const PORT = process.argv[2] || 4218;
const meta = { titles: ['元音声を保持する回'], description: '生成した概要欄です。', chapters: [{time:'00:00',label:'本題'}], hashtags:[], keywords:[], clips:[] };
(async () => {
  const browser = await chromium.launch(require('./browser-options'));
  try {
    const context = await browser.newContext({viewport:{width:390,height:844}});
    await context.addInitScript(() => {
      window.workerPurposes=[];
      const Original=window.Worker;
      window.Worker=class extends Original {
        postMessage(message,...rest) { window.workerPurposes.push(message.purpose || 'publish'); return super.postMessage(message,...rest); }
      };
    });
    let uploads=0, generations=0, fail=true;
    await context.route('**/generativelanguage.googleapis.com/**', route => {
      const url=route.request().url();
      if(url.includes('/models?')) return route.fulfill({json:{models:[{name:'models/gemini-3.5-flash',supportedGenerationMethods:['generateContent']}]}});
      if(url.includes('/upload/')) { uploads++; return route.fulfill({json:{file:{name:'files/mock',uri:'https://mock/audio',state:'ACTIVE'}}}); }
      if(url.includes(':generateContent')) {
        generations++;
        if(fail) return route.fulfill({status:400,json:{error:{message:'synthetic failure'}}});
        const answer=JSON.stringify(meta);
        return route.fulfill({json:{candidates:[{content:{parts:[{thought:true,text:'ignored'},{text:answer.slice(0,20)},{text:answer.slice(20)}]}}]}});
      }
      return route.fulfill({status:404,body:'mock-only'});
    });
    const page=await context.newPage();
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://localhost:${PORT}/`);
    await page.fill('input[type=password]','AIzaMOCK');
    await page.getByRole('button',{name:'保存して閉じる'}).click();
    await openLegacy(page);
    await page.locator('.legacy-production .drop input[type=file]').first().setInputFiles('speechlike.wav');
    await page.waitForSelector('.error',{timeout:120000});
    assert.deepEqual(await page.evaluate(()=>window.workerPurposes),['ai'],'normal flow must use AI-only conversion');
    assert.equal(uploads,1);
    // Resume from durable pending after a full reload. Uploaded reference must survive.
    await page.reload();
    await openLegacy(page);
    fail=false;
    await page.getByRole('button',{name:'文章の生成から続ける'}).click();
    await page.waitForSelector("h2:has-text('投稿素材が完成しました')",{timeout:120000});
    assert.deepEqual(await page.evaluate(()=>window.workerPurposes),[],'resume must not reconvert');
    assert.equal(uploads,1,'resume must reuse uploaded audio');
    assert.equal(generations,2);
    assert(await page.locator('.title-option').first().textContent().then(t=>t.includes(meta.titles[0])));
    const download=page.locator('a.dl').first();
    const got=await page.evaluate(async url=>{
      const bytes=await(await fetch(url)).arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
    },await download.getAttribute('href'));
    assert.equal(got,crypto.createHash('sha256').update(fs.readFileSync('speechlike.wav')).digest('hex'),'download must preserve original bytes');
    assert.equal(await download.getAttribute('download'),'speechlike.wav');
    await page.waitForFunction(async()=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('podcast-br');r.onsuccess=()=>resolve(r.result);r.onerror=reject;});
      const rows=await new Promise((resolve,reject)=>{const r=db.transaction('episodes').objectStore('episodes').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=reject;});db.close();return rows.some(r=>r.meta.titles[0]==='元音声を保持する回'&&r.audio?.size>0);
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByText(/処理時間の診断/).click();
    const diagnostic = page.getByRole('textbox', { name: '処理時間の記録' });
    const report = await diagnostic.inputValue();
    assert.match(report, /生成要求 \(generation-request\).*HTTP 200/);
    assert.match(report, /結果の表示 \(result-display\)/);
    assert.doesNotMatch(report, /AIzaMOCK|mock\/audio|speechlike|元音声を保持する回|生成した概要欄/);
    await page.getByRole('button', { name: '処理時間をコピー' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), report);
    await page.getByRole('button', { name: '計測をリセット' }).click();
    await page.getByText('処理時間の診断（0件）').waitFor();
    assert.deepEqual(errors,[]);
    console.log('OK: AI-only conversion, persisted resume, upload reuse, original bytes, history, metadata, mobile UI');
  } finally { await browser.close(); }
})().catch(e=>{console.error('FAIL:',e);process.exitCode=1;});
