// payoss クローラー。n8n から内部ネットワーク経由で呼ぶ前提（外部公開しない）。
//
//   POST /payoss/login    ... ログイン→次画面へ遷移できるか検証（URL/タイトル/スクショを返す）
//   POST /payoss/export   ... ログイン後に CSV/PDF をダウンロード（ダウンロードボタンのセレクタは後で確定）
//   Header: X-Internal-Token: <CRAWLER_TOKEN>
//   Body:   { "user": "...", "pass": "..." }
//
// 実セレクタ（2026-06 時点、実画面解析で確認）:
//   ユーザーID  : #login_userid
//   パスワード  : #login_pass
//   ログインボタン: #login_btn  (type=button / JS でフォーム main を POST)

import express from 'express';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.CRAWLER_TOKEN || '';
const LOGIN_URL = 'https://www.payoss.jp/multi_service/php/login/index.php';
// 左メニュー「決済明細」の遷移先（直リンク）
const MEISAI_URL = 'https://www.payoss.jp/multi_service/php/payment/dtl/payment_detail.php';

// --- stera code（member.steracode.jp / ASP.NET Identity。ボット対策なし＝headlessでOK）---
const STERA_LOGIN_URL = 'https://member.steracode.jp/Auth/Account/Login';
const STERA_SETTLE_URL = 'https://member.steracode.jp/Store/Settle';
const STERA_EMAIL_SEL = '#Input_Email';
const STERA_PW_SEL = '#Input_Password';
const STERA_LOGIN_BTN = '#account button[type="submit"], #account input[type="submit"], #account button';

// --- SMBC カード加盟店サイト（Akamai でヘッドレス遮断のため実ブラウザで操作）---
const SMBC_LOGIN_URL = 'https://www.smbc-card.com/merchantx/xt_login/index.html';
const SMBC_ID_SEL = '#vp-view-VE0501-001_RS1001_optionalId';
const SMBC_PW_SEL = '#vp-view-VE0501-001_RS1001_password';
const SMBC_LOGIN_BTN = '#xt_optionalid_login';

// --- イオン 加盟店WEB明細サービス（ASP.NET WebForms。ボット対策なし＝headlessでOK）---
const AEON_LOGIN_URL = 'https://www.merchant.aeon.co.jp/merchantdetails/L0010.aspx';
const AEON_ID_SEL = '#ctl00_ctl00_ctl00_body_BodyMain_TxtUserId';
const AEON_PW_SEL = '#ctl00_ctl00_ctl00_body_BodyMain_TxtPassword';
const AEON_LOGIN_BTN = '#ctl00_ctl00_ctl00_body_BodyMain_BtnLogin';

const app = express();
app.use(express.json({ limit: '50mb' }));

// 同一アカウントの多重ログインを避けるため、リクエストを逐次実行する
let queue = Promise.resolve();
function runExclusive(fn) {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

function auth(req, res) {
  if (!TOKEN || req.get('X-Internal-Token') !== TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- ログイン検証 ---
app.post('/payoss/login', async (req, res) => {
  if (!auth(req, res)) return;
  const { user, pass } = req.body || {};
  if (!user || !pass) return res.status(400).json({ error: 'user and pass are required' });
  try {
    const result = await runExclusive(() => withBrowser(async (page) => {
      await doLogin(page, user, pass);
      const shot = await page.screenshot({ fullPage: true });
      const url = page.url();
      return {
        loggedIn: !/\/login\/index\.php/.test(url),   // ログイン画面から離れていれば成功とみなす
        landedUrl: url,
        title: await page.title(),
        screenshot_base64: shot.toString('base64'),
      };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err), screenshot_base64: err?.screenshot_base64 });
  }
});

// --- ログイン → 決済明細を開く ---
app.post('/payoss/meisai', async (req, res) => {
  if (!auth(req, res)) return;
  // 認証情報はリクエストボディ優先、無ければ crawler の環境変数を使用
  const user = req.body?.user || process.env.PAYOSS_USER;
  const pass = req.body?.pass || process.env.PAYOSS_PASS;
  if (!user || !pass) return res.status(400).json({ error: 'user and pass are required' });
  try {
    const result = await runExclusive(() => withBrowser(async (page) => {
      await doLogin(page, user, pass);
      await gotoMeisai(page);
      const shot = await page.screenshot({ fullPage: false });
      const url = page.url();
      return {
        onMeisai: /\/payment\/dtl\/payment_detail\.php/.test(url),
        landedUrl: url,
        title: await page.title(),
        screenshot_base64: shot.toString('base64'),
      };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err), screenshot_base64: err?.screenshot_base64 });
  }
});

// --- ログイン → 決済明細 → 期間指定 → CSV/PDF をダウンロード ---
//   Body: { from?: "yyyyMMdd", to?: "yyyyMMdd" } （省略時は画面の既定＝当日）
//   ※ CSV は Shift-JIS(CP932) で返るため、n8n 側で UTF-8 に変換すること。
app.post('/payoss/export', async (req, res) => {
  if (!auth(req, res)) return;
  const user = req.body?.user || process.env.PAYOSS_USER;
  const pass = req.body?.pass || process.env.PAYOSS_PASS;
  const { from, to } = req.body || {};
  if (!user || !pass) return res.status(400).json({ error: 'user and pass are required' });
  try {
    const result = await runExclusive(() => withBrowser(async (page) => {
      await doLogin(page, user, pass);
      await gotoMeisai(page);

      // 抽出条件（期間）を指定して「この条件に変更する」で適用
      if (from || to) {
        if (from) await page.fill('#start_date', from);
        if (to) await page.fill('#end_date', to);
        await Promise.all([
          page.waitForLoadState('networkidle').catch(() => {}),
          page.click('#search_cond_decide_btn'),
        ]);
        await page.waitForTimeout(1500);
      }

      // CSV → PDF を連続ダウンロード。
      // データ0件だとボタンが発火しない（ファイルが生成されない）ため、
      // 一定時間で download イベントが来なければ「該当なし」とみなす。
      const csv = await tryDownload(page, '#output_csv', 30000);
      if (!csv) {
        return {
          period: { from: from || null, to: to || null },
          message: '指定期間に該当する決済明細がありません',
          csv_filename: null, csv_base64: null, pdf_filename: null, pdf_base64: null,
        };
      }
      // PDF 生成は大量データだと 40〜50秒かかることがあるため長めに待つ
      const pdf = await tryDownload(page, '#output_pdf', 60000);
      return {
        period: { from: from || null, to: to || null },
        csv_filename: csv.filename,
        csv_base64: csv.base64, // Shift-JIS のまま base64 化
        pdf_filename: pdf ? pdf.filename : null,
        pdf_base64: pdf ? pdf.base64 : null,
      };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err), screenshot_base64: err?.screenshot_base64 });
  }
});

// ブラウザ起動〜後始末を共通化（失敗時はスクショを例外に添付）
async function withBrowser(fn) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  try {
    return await fn(page);
  } catch (err) {
    try { err.screenshot_base64 = (await page.screenshot({ fullPage: true })).toString('base64'); } catch { /* ignore */ }
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
}

// ログイン → 次画面へ遷移
async function doLogin(page, user, pass) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.fill('#login_userid', user);
  await page.fill('#login_pass', pass);

  // ログインボタンは type=button（JS でフォーム送信）。URL がログイン画面から変わるのを待つ
  const navigated = page
    .waitForURL((u) => !u.toString().includes('/login/index.php'), { timeout: 20000 })
    .catch(() => null);
  await page.click('#login_btn');
  await navigated;
  await page.waitForLoadState('networkidle').catch(() => {});
}

// 決済明細ページへ遷移（左メニュー「決済明細」= 直リンク）
async function gotoMeisai(page) {
  await page.goto(MEISAI_URL, { waitUntil: 'networkidle' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500); // 明細テーブル描画待ち
}

async function downloadByClick(page, selector) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
  const filePath = await download.path();
  const buf = await readFile(filePath);
  return { filename: download.suggestedFilename(), base64: buf.toString('base64') };
}

// クリックしても一定時間で download が来なければ null（＝該当データなし等）
async function tryDownload(page, selector, timeout = 20000) {
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      page.click(selector),
    ]);
    const buf = await readFile(await download.path());
    return { filename: download.suggestedFilename(), base64: buf.toString('base64') };
  } catch {
    return null;
  }
}

// ===== stera code =====

async function doSteraLogin(page, user, pass) {
  await page.goto(STERA_LOGIN_URL, { waitUntil: 'networkidle' });
  await page.fill(STERA_EMAIL_SEL, user);
  await page.fill(STERA_PW_SEL, pass);
  const navigated = page
    .waitForURL((u) => !u.toString().includes('/Auth/Account/Login'), { timeout: 30000 })
    .catch(() => null);
  await page.click(STERA_LOGIN_BTN);
  await navigated;
  await page.waitForLoadState('networkidle').catch(() => {});
}

// ログイン検証（stera はボット対策なしのため headless でOK）
app.post('/stera/login', async (req, res) => {
  if (!auth(req, res)) return;
  const user = req.body?.user || process.env.STERA_USER;
  const pass = req.body?.pass || process.env.STERA_PASS;
  if (!user || !pass) return res.status(400).json({ error: 'user and pass are required' });
  try {
    const result = await runExclusive(() => withBrowser(async (page) => {
      await doSteraLogin(page, user, pass);
      const shot = await page.screenshot({ fullPage: false });
      const url = page.url();
      return {
        loggedIn: !/\/Auth\/Account\/Login/.test(url),
        landedUrl: url,
        title: await page.title(),
        screenshot_base64: shot.toString('base64'),
      };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err), screenshot_base64: err?.screenshot_base64 });
  }
});

// 加盟店精算書検索ページへ遷移して計上年月で検索
async function steraGotoSearch(page, year, month) {
  await page.goto(STERA_SETTLE_URL, { waitUntil: 'networkidle' });
  await page.selectOption('#TransactionY', String(year));
  await page.selectOption('#TransactionM', String(month).padStart(2, '0'));
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.click('#searchForm button[type="submit"]'),
  ]);
  await page.waitForTimeout(1500);
}

// 月別精算書一覧の各行で「精算書(PDF)」「精算明細(CSV)」を取得。
// 仕組み: 準備ボタン押下 → 署名付きURLのDLリンクが出現 → そのURLを fetch して実体取得。
// （全加盟店合計行は *zip-prepare-btn で別物のため対象外）
// 署名URLは生成が間に合わないとHTMLプレースホルダを返すことがあるので、
// 実体（HTMLでない）が返るまで数回リトライしてから取得する。
async function fetchSignedReady(context, href) {
  let buf = Buffer.alloc(0);
  for (let i = 0; i < 6; i++) {
    const resp = await context.request.get(href);
    buf = Buffer.from(await resp.body());
    const ct = resp.headers()['content-type'] || '';
    const head = buf.toString('latin1', 0, 16);
    const looksHtml = ct.includes('text/html') || /^\s*<(!doctype|html)/i.test(head);
    if (!looksHtml && buf.length > 0) return buf; // 実体取得OK
    await new Promise((r) => setTimeout(r, 2500)); // 生成待ち
  }
  return buf; // 最終結果（HTMLのままなら呼び出し側で valid=false 判定）
}

async function steraDownloadMonthly(page) {
  const context = page.context();
  const files = [];
  const codes = await page
    .locator('button.pdf-prepare-btn')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-c')));
  for (const code of codes) {
    for (const s of [
      { prep: 'pdf-prepare-btn', dl: 'a.pdf-download-btn', kind: '精算書', type: 'pdf' },
      { prep: 'csv-prepare-btn', dl: 'a.csv-download-btn', kind: '精算明細', type: 'csv' },
    ]) {
      const btn = page.locator(`button.${s.prep}[data-c="${code}"]`);
      const row = btn.locator('xpath=ancestor::tr[1]');
      await btn.click();
      const link = row.locator(s.dl);
      await link.waitFor({ state: 'visible', timeout: 60000 }); // 署名URL生成待ち
      const href = await link.getAttribute('href');
      const buf = await fetchSignedReady(context, href);
      const head = buf.toString('latin1', 0, 5);
      const valid = s.type === 'pdf' ? head === '%PDF-' : !/^\s*<(!|h)/i.test(head); // CSVはHTMLでなければOK
      const filename =
        decodeURIComponent((href.split('/').pop() || '').split('?')[0]) || `${code}_${s.kind}.${s.type}`;
      files.push({ kind: s.kind, type: s.type, code, filename, valid, bytes: buf.length, base64: buf.toString('base64') });
    }
  }
  return files;
}

// ログイン → 加盟店精算書一覧 → 計上年月で検索 → 月別の精算書PDF＋精算明細CSVを取得
app.post('/stera/export', async (req, res) => {
  if (!auth(req, res)) return;
  const user = req.body?.user || process.env.STERA_USER;
  const pass = req.body?.pass || process.env.STERA_PASS;
  const year = req.body?.year ? String(req.body.year) : '';
  const month = req.body?.month ? String(req.body.month).padStart(2, '0') : '';
  if (!user || !pass) return res.status(400).json({ error: 'user and pass are required' });
  if (!year || !month) return res.status(400).json({ error: 'year and month required (e.g. {"year":"2026","month":"05"})' });
  try {
    const result = await runExclusive(() => withBrowser(async (page) => {
      await doSteraLogin(page, user, pass);
      await steraGotoSearch(page, year, month);
      const files = await steraDownloadMonthly(page);
      return { year, month, count: files.length, files };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err), screenshot_base64: err?.screenshot_base64 });
  }
});

// ===== SMBC カード加盟店サイト =====

// 実ブラウザ(ヘッドフル)で起動。UA等は改変せず素のChromeを使う（ボット検知回避はしない）。
async function withSmbcBrowser(fn) {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8' },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  try {
    return await fn(page);
  } catch (err) {
    try { err.screenshot_base64 = (await page.screenshot({ fullPage: true })).toString('base64'); } catch { /* ignore */ }
    throw err;
  } finally {
    await context.close();
    await browser.close();
  }
}

async function doSmbcLogin(page, user, pass) {
  // フォーム描画が不安定なため、表示されるまで実ブラウザで最大3回リロードして待つ
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    await page.goto(SMBC_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForSelector(SMBC_ID_SEL, { state: 'visible', timeout: 25000 });
      ok = true;
    } catch {
      await page.waitForTimeout(2000);
    }
  }
  if (!ok) throw new Error('SMBCログインフォームが表示されませんでした（Akamaiのボット遮断の可能性）');
  await page.fill(SMBC_ID_SEL, user);
  await page.fill(SMBC_PW_SEL, pass);
  const navigated = page
    .waitForURL((u) => !u.toString().includes('/xt_login/'), { timeout: 30000 })
    .catch(() => null);
  await page.click(SMBC_LOGIN_BTN);
  await navigated;
  await page.waitForLoadState('networkidle').catch(() => {});
}

// ログイン検証
app.post('/smbc/login', async (req, res) => {
  if (!auth(req, res)) return;
  const user = req.body?.user || process.env.SMBC_USER;
  const pass = req.body?.pass || process.env.SMBC_PASS;
  if (!user || !pass) return res.status(400).json({ error: 'user and pass are required' });
  try {
    const result = await runExclusive(() => withSmbcBrowser(async (page) => {
      await doSmbcLogin(page, user, pass);
      const shot = await page.screenshot({ fullPage: false });
      const url = page.url();
      return {
        loggedIn: !/\/xt_login\//.test(url),
        landedUrl: url,
        title: await page.title(),
        screenshot_base64: shot.toString('base64'),
      };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err), screenshot_base64: err?.screenshot_base64 });
  }
});

// ===== イオン 加盟店WEB明細サービス =====

async function doAeonLogin(page, user, pass) {
  await page.goto(AEON_LOGIN_URL, { waitUntil: 'networkidle' });
  await page.fill(AEON_ID_SEL, user);
  await page.fill(AEON_PW_SEL, pass);
  // ログイン後は別ページへ遷移（L0010.aspx から離れる）想定。離れなければ postback（失敗等）
  const navigated = page
    .waitForURL((u) => !/L0010\.aspx/i.test(u.toString()), { timeout: 30000 })
    .catch(() => null);
  await page.click(AEON_LOGIN_BTN);
  await navigated;
  await page.waitForLoadState('networkidle').catch(() => {});
}

// ログイン検証（→次画面へ遷移できるか）
app.post('/aeon/login', async (req, res) => {
  if (!auth(req, res)) return;
  const user = req.body?.user || process.env.AEON_USER;
  const pass = req.body?.pass || process.env.AEON_PASS;
  if (!user || !pass) return res.status(400).json({ error: 'user and pass are required' });
  try {
    const result = await runExclusive(() => withBrowser(async (page) => {
      await doAeonLogin(page, user, pass);
      const stillLogin = (await page.locator(AEON_ID_SEL).count()) > 0;
      const url = page.url();
      const shot = await page.screenshot({ fullPage: false });
      return {
        loggedIn: !stillLogin && !/L0010\.aspx/i.test(url),
        stillOnLoginForm: stillLogin,
        landedUrl: url,
        title: await page.title(),
        screenshot_base64: shot.toString('base64'),
      };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err), screenshot_base64: err?.screenshot_base64 });
  }
});

// 検索条件で日付範囲を指定して検索 → 各行を取得
// （CSVダウンロード列の閲覧があればCSV、無ければ帳票閲覧列の閲覧＝PDF）
// dateField: '05'=帳票作成日 / '06'=帳票のデータ締日 / '07'=精算日（既定）
async function aeonExport(page, { from, to, dateField }) {
  const base = '#ctl00_ctl00_ctl00_body_BodyMain_';
  // 検索条件パネルを展開（日付テキストボックスは展開後に出現する）
  await page.click('text=検索条件').catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(800);
  if (from) await page.fill(`${base}CtrlKeyItem${dateField}From`, from);
  if (to) await page.fill(`${base}CtrlKeyItem${dateField}To`, to);
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.click(`${base}BtnSearch`),
  ]);
  await page.waitForTimeout(1500);

  // 結果行ごとの「帳票閲覧」ボタンid（1行に必ず1つ）を収集
  const browseIds = await page
    .locator('input[id^="ctl00_ctl00_ctl00_body_BodyMain_ListViewSearchResultList_"][id$="_BtnBrowse"]')
    .evaluateAll((els) => els.map((e) => e.id));
  const files = [];
  for (const browseId of browseIds) {
    const csvId = browseId.replace('_BtnBrowse', '_BtnCsvBrowse');
    const hasCsv = (await page.locator('#' + csvId).count()) > 0; // CSVダウンロード列に閲覧があるか
    const targetId = hasCsv ? csvId : browseId;
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 40000 }),
      page.click('#' + targetId),
    ]);
    const buf = await readFile(await download.path());
    files.push({
      type: hasCsv ? 'csv' : 'pdf',
      filename: download.suggestedFilename(),
      bytes: buf.length,
      base64: buf.toString('base64'),
    });
    await page.waitForTimeout(400);
  }
  return files;
}

// ログイン → 帳票一覧 → 日付指定検索 → 各行のCSV/PDFを取得
app.post('/aeon/export', async (req, res) => {
  if (!auth(req, res)) return;
  const user = req.body?.user || process.env.AEON_USER;
  const pass = req.body?.pass || process.env.AEON_PASS;
  const from = req.body?.from ? String(req.body.from) : '';
  const to = req.body?.to ? String(req.body.to) : '';
  const dateField = req.body?.dateField ? String(req.body.dateField) : '07'; // 既定:精算日
  if (!user || !pass) return res.status(400).json({ error: 'user and pass are required' });
  try {
    const result = await runExclusive(() => withBrowser(async (page) => {
      await doAeonLogin(page, user, pass);
      const files = await aeonExport(page, { from, to, dateField });
      return { from: from || null, to: to || null, dateField, count: files.length, files };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err), screenshot_base64: err?.screenshot_base64 });
  }
});

app.listen(PORT, () => console.log(`crawler listening on :${PORT}`));
