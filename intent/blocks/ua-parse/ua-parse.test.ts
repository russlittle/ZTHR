import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCEPT_CH, MAX_UA_LENGTH, RULES_VERSION, describe, detectBot, parse, parseBrands, parseUserAgent, pickBrand, sfBoolean, sfString, withTouch } from './index.ts';

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.67',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  androidTablet: 'Mozilla/5.0 (Linux; Android 12; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  webview: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36',
  reducedAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ie11: 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko',
  ie9: 'Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; Trident/5.0)',
  playstation: 'Mozilla/5.0 (PlayStation; PlayStation 5/2.26) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
  tizenTv: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36',
  facebookIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.0.0;FBDV/iPhone14,2]',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  googlebotPhone: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.201 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bing: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  gpt: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
  claude: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36',
};

const row = (ua: string) => {
  const p = parseUserAgent(ua);
  return [p.browser.name, p.browser.major, p.os.name, p.os.version, p.device.type];
};

test('desktop browsers: name, major version, system and class', () => {
  assert.deepEqual(row(UA.chromeWin), ['Chrome', 124, 'Windows', '10', 'desktop']);
  assert.deepEqual(row(UA.firefoxWin), ['Firefox', 125, 'Windows', '10', 'desktop']);
  assert.deepEqual(row(UA.firefoxLinux), ['Firefox', 125, 'Linux', null, 'desktop']);
  assert.deepEqual(row(UA.safariMac), ['Safari', 17, 'macOS', '10.15.7', 'desktop']);
  assert.deepEqual(row(UA.chromeOs), ['Chrome', 124, 'ChromeOS', '14541.0.0', 'desktop']);
});

test('browsers that wear Chrome\'s coat are named for what they are', () => {
  assert.deepEqual(row(UA.edge).slice(0, 2), ['Edge', 124]);
  assert.equal(parseUserAgent(UA.edge).browser.version, '124.0.2478.67');
  assert.deepEqual(row(UA.opera).slice(0, 2), ['Opera', 110]);
  assert.equal(parseUserAgent(UA.samsung).browser.name, 'Samsung Internet');
  assert.equal(parseUserAgent(UA.webview).browser.name, 'Android WebView');
  assert.equal(parseUserAgent(UA.chromeWin).browser.engine, 'Blink');
  assert.equal(parseUserAgent(UA.firefoxWin).browser.engine, 'Gecko');
  assert.equal(parseUserAgent(UA.safariMac).browser.engine, 'WebKit');
});

test('phones and tablets: iOS and Android, with vendor and model where the string carries them', () => {
  const iphone = parseUserAgent(UA.iphone);
  assert.deepEqual([iphone.os, iphone.device], [{ name: 'iOS', version: '17.4.1' }, { type: 'mobile', vendor: 'Apple', model: 'iPhone' }]);
  assert.deepEqual(parseUserAgent(UA.ipad).device, { type: 'tablet', vendor: 'Apple', model: 'iPad' });
  assert.equal(parseUserAgent(UA.chromeIos).browser.name, 'Chrome');
  const pixel = parseUserAgent(UA.androidChrome);
  assert.deepEqual([pixel.os, pixel.device], [{ name: 'Android', version: '14' }, { type: 'mobile', vendor: 'Google', model: 'Pixel 8' }]);
  assert.deepEqual(parseUserAgent(UA.samsung).device, { type: 'mobile', vendor: 'Samsung', model: 'SM-S918B' });
  assert.deepEqual(parseUserAgent(UA.androidTablet).device, { type: 'tablet', vendor: 'Samsung', model: 'SM-T870' }, 'Android without "Mobile" is a tablet');
  assert.deepEqual(parseUserAgent(UA.webview).device.model, 'Pixel 7');
  assert.deepEqual(parseUserAgent(UA.firefoxAndroid).device.type, 'mobile');
});

test('the frozen "K" model of a reduced Android string is not a model', () => {
  const p = parseUserAgent(UA.reducedAndroid);
  assert.deepEqual([p.os, p.device], [{ name: 'Android', version: '10' }, { type: 'mobile', vendor: null, model: null }]);
});

test('old and unusual clients', () => {
  assert.deepEqual(row(UA.ie11), ['Internet Explorer', 11, 'Windows', '10', 'desktop']);
  assert.deepEqual(row(UA.ie9), ['Internet Explorer', 9, 'Windows', '7', 'desktop']);
  assert.equal(parseUserAgent(UA.playstation).device.type, 'console');
  assert.equal(parseUserAgent(UA.tizenTv).device.type, 'tv');
  assert.equal(parseUserAgent(UA.facebookIos).browser.name, 'Facebook App');
  assert.equal(parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148').browser.name, 'WebKit WebView');
});

test('bots are named with their kind, and the device class becomes bot', () => {
  const g = parseUserAgent(UA.googlebot);
  assert.deepEqual(g.bot, { name: 'Googlebot', kind: 'search' });
  assert.equal(g.device.type, 'bot');
  assert.deepEqual(detectBot(UA.googlebotPhone), { name: 'Googlebot', kind: 'search' }, 'a phone-shaped Googlebot is still Googlebot');
  assert.deepEqual(detectBot(UA.bing), { name: 'bingbot', kind: 'search' });
  assert.deepEqual(detectBot(UA.gpt), { name: 'GPTBot', kind: 'ai' });
  assert.deepEqual(detectBot(UA.claude), { name: 'ClaudeBot', kind: 'ai' });
  assert.deepEqual(detectBot(UA.headless), { name: 'HeadlessChrome', kind: 'headless' });
  assert.deepEqual(detectBot('curl/8.4.0'), { name: 'curl', kind: 'library' });
  assert.deepEqual(detectBot('python-requests/2.31.0'), { name: 'python-requests', kind: 'library' });
  assert.deepEqual(detectBot('Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'), { name: 'AhrefsBot', kind: 'seo' });
  assert.deepEqual(detectBot('Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)'), { name: 'UptimeRobot', kind: 'monitor' });
  assert.deepEqual(detectBot('Twitterbot/1.0'), { name: 'Twitterbot', kind: 'social' });
});

test('an unnamed crawler is still flagged, and a person is not', () => {
  assert.deepEqual(detectBot('SomeCorp-Research-Spider/0.3'), { name: 'unidentified crawler', kind: 'crawler' });
  assert.equal(detectBot(UA.chromeWin), null);
  assert.equal(detectBot(UA.iphone), null);
  assert.equal(detectBot('Mozilla/5.0 (Windows NT 10.0) Chrome/124.0 Robotics Lab Browser'), null, '"Robotics" is not "bot"');
  assert.equal(detectBot(''), null);
});

test('input is capped, and a hostile string cannot make the rules slow', () => {
  const huge = `Mozilla/5.0 (${'(;'.repeat(500_000)}`;
  const t = Date.now();
  const p = parseUserAgent(huge);
  assert.ok(Date.now() - t < 500, 'a megabyte of brackets reads in well under half a second');
  assert.equal(p.truncated, true);
  const pad = `${UA.chromeWin} ${'x'.repeat(MAX_UA_LENGTH)} Googlebot/2.1`;
  assert.equal(parseUserAgent(pad).bot, null, 'a bot token hidden past the cap is not read');
  assert.equal(parseUserAgent(UA.chromeWin).truncated, false);
  assert.deepEqual(parseUserAgent('').browser, { name: 'unknown', version: null, major: null, engine: null });
  assert.equal(parseUserAgent('').device.type, 'unknown');
  assert.equal(parseUserAgent('\u0000‮<script>').os.name, 'unknown');
});

test('the result says which rule table read it', () => {
  assert.equal(parseUserAgent(UA.chromeWin).rules, RULES_VERSION);
});

test('client hint brands: structured fields are parsed, escapes honoured, junk dropped', () => {
  assert.deepEqual(parseBrands('"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"'), [{ brand: 'Chromium', version: '124' }, { brand: 'Google Chrome', version: '124' }, { brand: 'Not-A.Brand', version: '99' }]);
  assert.deepEqual(parseBrands('"Br\\"and";v="1"'), [{ brand: 'Br"and', version: '1' }]);
  assert.deepEqual(parseBrands('garbage, "Edge";v="2"'), [{ brand: 'Edge', version: '2' }]);
  assert.deepEqual(parseBrands('"Unclosed;v="1"'), []);
  assert.deepEqual(parseBrands(undefined), []);
  assert.deepEqual(parseBrands('"A";v="1",'.repeat(300)), []);
  assert.equal(sfString('"Windows"'), 'Windows');
  assert.equal(sfString('Windows'), null);
  assert.equal(sfString('"a" "b"'), null);
  assert.equal(sfBoolean('?1'), true);
  assert.equal(sfBoolean('?0'), false);
  assert.equal(sfBoolean('yes'), null);
});

test('the real brand is the named browser, not the GREASE entry or the engine', () => {
  assert.deepEqual(pickBrand(parseBrands('"Not/A)Brand";v="8", "Chromium";v="124", "Microsoft Edge";v="124"')), { brand: 'Microsoft Edge', version: '124' });
  assert.deepEqual(pickBrand(parseBrands('"Not_A Brand";v="8", "Chromium";v="124"')), { brand: 'Chromium', version: '124' });
  assert.equal(pickBrand(parseBrands('"Not A;Brand";v="99"')), null);
});

test('hints outrank the string: Windows 11, Brave, full versions and the real model', () => {
  const p = parse(UA.chromeWin, {
    'sec-ch-ua': '"Chromium";v="124", "Brave";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-full-version-list': '"Chromium";v="124.0.6367.82", "Brave";v="124.0.6367.82", "Not-A.Brand";v="99.0.0.0"',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-platform-version': '"15.0.0"',
    'sec-ch-ua-mobile': '?0',
  });
  assert.deepEqual(p.browser, { name: 'Brave', version: '124.0.6367.82', major: 124, engine: 'Blink' });
  assert.deepEqual(p.os, { name: 'Windows', version: '11' });
  assert.deepEqual(p.fromHints, ['browser', 'os', 'device']);
  assert.equal(parse(UA.chromeWin, { 'sec-ch-ua-platform': '"Windows"', 'sec-ch-ua-platform-version': '"10.0.0"' }).os.version, '10');
  const phone = parse(UA.reducedAndroid, { 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-model': '"Pixel 8 Pro"', 'sec-ch-ua-platform': '"Android"', 'sec-ch-ua-platform-version': '"14.0.0"' });
  assert.deepEqual([phone.device.model, phone.os.version, phone.device.type], ['Pixel 8 Pro', '14.0.0', 'mobile']);
});

test('without hints, or with useless ones, the string stands; Chromium alone does not hide Chrome', () => {
  assert.deepEqual(parse(UA.chromeWin), parseUserAgent(UA.chromeWin));
  const p = parse(UA.chromeWin, { 'sec-ch-ua': '"Chromium";v="124", "Not-A.Brand";v="99"', 'sec-ch-ua-full-version-list': '"Chromium";v="124.0.6367.82"' });
  assert.deepEqual([p.browser.name, p.browser.version], ['Chrome', '124.0.6367.82']);
  assert.deepEqual(p.fromHints, []);
  const bad = parse(UA.chromeWin, { 'sec-ch-ua-platform': 'Windows' });
  assert.equal(bad.os.name, 'Windows');
  assert.ok(ACCEPT_CH.includes('Sec-CH-UA-Platform-Version'));
});

test('hints cannot turn a bot into a person', () => {
  const p = parse(UA.googlebot, { 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-model': '"Pixel"' });
  assert.equal(p.device.type, 'bot');
  assert.equal(p.device.model, null);
});

test('an iPad that says Macintosh is an iPad when it has a touch screen', () => {
  const p = parseUserAgent(UA.safariMac);
  assert.equal(withTouch(p, 0).os.name, 'macOS');
  assert.deepEqual(withTouch(p, 5).device, { type: 'tablet', vendor: 'Apple', model: 'iPad' });
  assert.equal(withTouch(parseUserAgent(UA.chromeWin), 5).os.name, 'Windows');
});

test('a one-line description for reports', () => {
  assert.equal(describe(parse(UA.chromeWin, { 'sec-ch-ua-platform': '"Windows"', 'sec-ch-ua-platform-version': '"13.0.0"' })), 'Chrome 124 on Windows 11 (desktop)');
  assert.equal(describe(parseUserAgent(UA.googlebot)), 'Googlebot (search bot)');
  assert.equal(describe(parseUserAgent('')), 'Unknown browser on unknown system (unknown)');
});
