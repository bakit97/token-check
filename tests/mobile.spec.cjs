const { test, expect } = require('@playwright/test');
const TOKEN='So11111111111111111111111111111111111111112';
test.use({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
test('Six panels, age admission, safe settings and local filter management work on a phone',async({page},testInfo)=>{
  const errors=[],now=Date.now();
  page.on('pageerror',error=>errors.push(String(error)));
  const c={a:TOKEN,n:'Проверочная монета',s:'CHECK',p:TOKEN,d:'pumpswap',
    t:now-20*60_000,mst:'ok',mk:'pump',mT:now-20*60_000,
    mSeen:now-20*60_000+1200,
    ds:[[Math.floor(now/1000),0.0001,20000,30000,25,5,2000]]};
  const admitted={a:TOKEN,n:c.n,s:c.s,phase:'after',
    eventAt:now-20*60_000,acceptedAt:now-20*60_000+1200};
  const source={mode:'verified-pre-post',updated:now,
    today:1,todayBefore:0,todayAfter:1,
    settings:{beforeMinutes:2,afterMinutes:2},preConnected:true};
  source.dailyAvailability={before:false,after:true};
  source.daily={schema:1,day:new Date(now+5*3600000).toISOString().slice(0,10),complete:true,
    before:{seen:0,accepted:0,tooOld:0,unverified:0},
    after:{seen:1240,accepted:312,tooOld:870,unverified:58,averageLateMs:90000}};
  const research={status:'observational',updated:now,
    counts:{live:0,dead:0,preLive:0,preDead:0,postLive:0,postDead:0},
    settings:{hours:5,minActive:70,maxIdle:60,decisionMinutes:10},
    pending:{'not-yet-finished':1}};
  await page.route('https://storage.googleapis.com/sol-scan-511718-data/**',route=>{
    const pathname=new URL(route.request().url()).pathname;
    let response={coins:[]};
    if(pathname.endsWith('/source/status.json'))response=source;
    else if(pathname.includes('/source/day/')||pathname.endsWith('/source/live.json'))response={coins:[admitted]};
    else if(pathname.endsWith('/research-v2/status.json'))response=research;
    else if(pathname.endsWith('/research-v2/polygon-1.json'))response={counts:research.counts,coins:[]};
    else if(pathname.endsWith('/status.json'))response={updated:now};
    else if(pathname.includes('/obs/'))response={coins:[]};
    else if(pathname.includes('/day/')||pathname.endsWith('/live.json'))response={coins:[c]};
    return route.fulfill({status:200,contentType:'application/json',
      headers:{'access-control-allow-origin':'*'},body:JSON.stringify(response)});
  });
  await page.goto('http://127.0.0.1:8765/v2.html',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#net')).toHaveText('● LIVE',{timeout:15000});
  await expect(page.locator('#tabs [data-page]')).toHaveCount(6);
  await expect(page.locator('#dailyBefore')).toHaveText('До миграции: нет данных');
  await expect(page.locator('#dailyAfter')).toContainText('прошли 312');
  await expect(page.locator('#dailyAfter')).toContainText('1,5 мин');
  await expect(page.locator('#coinList')).toContainText('Проверочная монета');
  await expect(page.locator('#admitCount')).toHaveText('1');
  await expect(page.locator('#visibleCount')).toHaveText('1');
  await page.locator('#allStreams [data-stream="after"]').click();
  await expect(page.locator('#coinList')).toContainText('Проверочная монета');
  await page.locator('#allStreams [data-stream="before"]').click();
  await expect(page.locator('#coinList')).not.toContainText('Проверочная монета');
  await page.locator('#allStreams [data-stream="all"]').click();
  await page.locator('#p-all details summary').click();
  await expect(page.locator('#ageBefore')).toBeDisabled();
  await page.locator('#cardLimit').selectOption('10');
  await page.locator('#applySource').click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('solscan_v2_state_20261017')).limit)).toBe(10);
  await page.locator('#tabs [data-page="mine"]').click();
  await expect(page.locator('#p-mine')).toBeVisible();
  await page.locator('[data-pick-source="before"][data-pick-level="1"]').click();
  await expect(page.locator('#filterPicker')).toBeVisible();
  await page.locator('#pickerClose').click();
  await page.locator('#tabs [data-page="passed"]').click();
  await page.locator('#decisionSettings summary').click();
  await expect(page.locator('#applyDecision')).toBeVisible();
  await page.locator('#decisionMins').evaluate(el=>{
    el.value='12';el.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await page.locator('#applyDecision').click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('solscan_v2_state_20261017')).decision)).toBe(12);
  await page.locator('#tabs [data-page="r1"]').click();
  await expect(page.locator('#r1Live')).toHaveText('0');
  await expect(page.locator('#r1Auto')).toContainText('Ожидают окончания наблюдения: 1');
  await expect(page.locator('#applyR1')).toBeDisabled();
  await page.locator('#tabs [data-page="r2"]').click();
  await expect(page.locator('#r2Graph')).toContainText('Нет монет с полной историей');
  await page.locator('#tabs [data-page="library"]').click();
  await page.locator('#createFilter').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#filterName').fill('Исследовательская проверка');
  await page.locator('#filterKey').selectOption('buyers');
  await page.locator('#filterValue').fill('20');
  await page.locator('#editor [type="submit"]').click();
  await expect(page.locator('#libraryList')).toContainText('Исследовательская проверка');
  await page.locator('#tabs [data-page="mine"]').click();
  await page.locator('[data-pick-source="after"][data-pick-level="1"]').click();
  await page.locator('#pickerItems [data-use]').first().click();
  await expect(page.locator('#activeModules')).toHaveText('0');
  await expect(page.locator('[data-apply-modules]')).toBeEnabled();
  await page.locator('[data-apply-modules]').click();
  await expect(page.locator('#activeModules')).toHaveText('1');
  await page.locator('#tabs [data-page="all"]').click();
  await page.screenshot({path:testInfo.outputPath('solscan-phone.png'),fullPage:true});
  expect(errors).toEqual([]);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});
