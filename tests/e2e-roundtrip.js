// Notespice end-to-end Writer <-> Markdown round-trip suite.
//
// Runs against a REAL browser and a REAL running server - not jsdom -
// because this project's history proved that contenteditable behavior
// can only be trusted when observed in an actual browser.
//
// To run:
//   1. Start the app:  NOTES_USERNAME=admin NOTES_PASSWORD=demo1234 \
//        NOTES_DIR=/tmp/nsp-test/notes NOTES_DATA_DIR=/tmp/nsp-test/data \
//        NOTES_PORT=8099 NOTES_INSECURE_COOKIES=true ./target/release/notespice
//   2. npm install playwright (and its chromium), adjust the two
//      executablePath/require lines below for your machine.
//   3. node tests/e2e-roundtrip.js
//
// Exit output ends with "TOTAL PASS: n  FAIL: n" and a JSON dump of
// any failures, each with the exact DOM and serialized markdown.
// Part A: markdown -> Writer -> markdown must be byte-stable.
// Part B: real toolbar/keyboard actions in Writer -> markdown must contain
//         the expected GFM, and a second mode round-trip must not drift.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const SINK = [
  '# Trip notes',
  '',
  'Plain text with **bold**, *italic*, ~~strike~~, and `code`.',
  '',
  '## Lists',
  '',
  '- one',
  '- two **bold item**',
  '  - nested',
  '',
  '1. first',
  '2. second',
  '',
  '- [ ] todo',
  '- [x] done',
  '',
  '> a quote with **bold** inside',
  '',
  '> [!WARNING]',
  '> caution text',
  '',
  '```rust',
  'let x = 1;',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| **1** | `2` |',
  '',
  'Link: [site](https://example.com) and image: ![alt](https://example.com/i.png)',
  '',
  'Footnote ref[^1]',
  '',
  '---',
  '',
  '[^1]: the footnote text',
].join('\n');

const MD_CASES = [
  { name: 'two paragraphs', md: 'One.\n\nTwo.' },
  { name: 'soft break', md: 'a\nb' },
  { name: 'hard break (2 spaces)', md: 'a  \nb' },
  { name: 'explicit <br> line', md: 'a\n\n<br>\nb' },
  { name: 'headings 1-6', md: '# A\n\n## B\n\n### C\n\n#### D\n\n##### E\n\n###### F' },
  { name: 'bold', md: 'x **a** y' },
  { name: 'italic', md: 'x *a* y' },
  { name: 'strike', md: 'x ~~a~~ y' },
  { name: 'inline code', md: 'x `a` y' },
  { name: 'nested bold-italic', md: '**a *b* c**' },
  { name: 'all inline mixed', md: 'a **b** *c* ~~d~~ `e` f' },
  { name: 'link', md: '[label](https://example.com)' },
  { name: 'image', md: '![alt](https://example.com/i.png)' },
  { name: 'bullet list', md: '- a\n- b' },
  { name: 'numbered list', md: '1. a\n2. b' },
  { name: 'nested list', md: '- a\n  - b\n- c' },
  { name: 'task list', md: '- [ ] a\n- [x] b' },
  { name: 'list with bold', md: '- **a**\n- b' },
  { name: 'quote plain', md: '> a' },
  { name: 'quote with bold', md: '> **a** and b' },
  { name: 'callout', md: '> [!TIP]\n> stay hydrated' },
  { name: 'code block', md: '```\nx = 1\n```' },
  { name: 'code block with lang', md: '```rust\nlet x = 1;\n```' },
  { name: 'hr between paras', md: 'a\n\n---\n\nb' },
  { name: 'table', md: '| A | B |\n| --- | --- |\n| 1 | 2 |' },
  { name: 'table with inline fmt', md: '| A | B |\n| --- | --- |\n| **1** | `2` |' },
  { name: 'footnote', md: 'a[^1]\n\n[^1]: note text' },
  { name: 'heading with bold', md: '# A **b**' },
  { name: 'kitchen sink', md: SINK },
];

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // queue of values to feed to window.prompt, consumed FIFO
  let promptQueue = [];
  page.on('dialog', async (d) => {
    const v = promptQueue.length ? promptQueue.shift() : null;
    if (d.type() === 'prompt') await d.accept(v ?? d.defaultValue());
    else await d.accept();
  });

  await page.goto('http://127.0.0.1:8099/');
  await page.waitForSelector('#login-username', { timeout: 10000 });
  await page.fill('#login-username', 'admin');
  await page.fill('#login-password', 'demo1234');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#new-note-btn', { timeout: 10000 });

  async function freshNote() {
    await page.click('#new-note-btn');
    await page.waitForFunction(
      () => document.getElementById('wysiwyg-editor').innerHTML === '<p></p>' &&
            document.getElementById('mode-wysiwyg').classList.contains('active'),
      { timeout: 10000 }
    );
    await page.click('#wysiwyg-editor');
  }

  async function toRaw() { await page.click('#mode-raw'); await page.waitForTimeout(60); }
  async function toWriter() { await page.click('#mode-wysiwyg'); await page.waitForTimeout(60); }
  const getMd = () => page.evaluate(() => currentMarkdown());
  const getDom = () => page.evaluate(() => document.getElementById('wysiwyg-editor').innerHTML);

  const failures = [];
  let passCount = 0;

  function record(name, ok, detail) {
    if (ok) { passCount++; console.log('PASS  ' + name); }
    else { failures.push({ name, ...detail }); console.log('FAIL  ' + name + '  ' + JSON.stringify(detail)); }
  }

  // ---------- Part A: markdown -> writer -> markdown stability ----------
  console.log('===== PART A: markdown -> Writer -> markdown =====');
  for (const c of MD_CASES) {
    await freshNote();
    await toRaw();
    await page.evaluate((md) => { el('raw-textarea').value = md; }, c.md);
    await toWriter();
    const md1 = await getMd();
    await toRaw(); await toWriter();
    const md2 = await getMd();
    const ok = md1 === c.md && md2 === c.md;
    record('A: ' + c.name, ok, ok ? {} : { expected: c.md, got1: md1, got2: md2 });
  }

  // ---------- Part B: real Writer actions ----------
  console.log('===== PART B: Writer actions -> markdown =====');

  // helper: type text then select all inside editor
  async function typeAndSelectAll(text) {
    await page.keyboard.type(text);
    await page.keyboard.press('Control+a');
  }
  // helper: select a substring of the first text node in the editor
  async function selectSubstring(sub) {
    await page.evaluate((sub) => {
      const ed = document.getElementById('wysiwyg-editor');
      const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const idx = n.textContent.indexOf(sub);
        if (idx !== -1) {
          const r = document.createRange();
          r.setStart(n, idx);
          r.setEnd(n, idx + sub.length);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
          return;
        }
      }
      throw new Error('substring not found: ' + sub);
    }, sub);
  }

  async function actionCase(name, actions, check) {
    await freshNote();
    try {
      await actions();
    } catch (e) {
      record('B: ' + name, false, { error: String(e) });
      return;
    }
    const dom = await getDom();
    const md1 = await getMd();
    await toRaw(); await toWriter();
    const md2 = await getMd();
    const res = check(md1);
    const stable = md1 === md2;
    record('B: ' + name, res === true && stable,
      res === true && stable ? {} : { dom, md1, md2, why: res === true ? 'unstable round-trip' : res });
  }

  await actionCase('type, select-all, Bold button',
    async () => { await typeAndSelectAll('hello world'); await page.click('[data-cmd="bold"]'); },
    (md) => md === '**hello world**' || 'expected **hello world**, got ' + JSON.stringify(md));

  await actionCase('type, select-all, Ctrl+B',
    async () => { await typeAndSelectAll('hello world'); await page.click('#wysiwyg-editor'); await page.keyboard.press('Control+a'); await page.keyboard.press('Control+b'); },
    (md) => md === '**hello world**' || 'expected **hello world**, got ' + JSON.stringify(md));

  await actionCase('partial selection Bold',
    async () => { await page.keyboard.type('one two three'); await selectSubstring('two'); await page.click('[data-cmd="bold"]'); },
    (md) => md === 'one **two** three' || 'got ' + JSON.stringify(md));

  await actionCase('bold then unbold (toggle twice)',
    async () => { await typeAndSelectAll('plain again'); await page.click('[data-cmd="bold"]'); await page.keyboard.press('Control+a'); await page.click('[data-cmd="bold"]'); },
    (md) => md === 'plain again' || 'got ' + JSON.stringify(md));

  await actionCase('Italic button',
    async () => { await typeAndSelectAll('slanted'); await page.click('[data-cmd="italic"]'); },
    (md) => md === '*slanted*' || 'got ' + JSON.stringify(md));

  await actionCase('Strike button',
    async () => { await typeAndSelectAll('gone'); await page.click('[data-cmd="strike"]'); },
    (md) => md === '~~gone~~' || 'got ' + JSON.stringify(md));

  await actionCase('Inline code button',
    async () => { await typeAndSelectAll('let x'); await page.click('[data-cmd="code"]'); },
    (md) => md === '`let x`' || 'got ' + JSON.stringify(md));

  await actionCase('bold+italic stacked',
    async () => { await typeAndSelectAll('both'); await page.click('[data-cmd="bold"]'); await page.keyboard.press('Control+a'); await page.click('[data-cmd="italic"]'); },
    (md) => (md === '***both***' || md === '**_both_**' || md === '***both***') || 'got ' + JSON.stringify(md));

  await actionCase('Heading 2 via dropdown',
    async () => { await page.keyboard.type('section title'); await page.selectOption('#heading-select', 'H2'); },
    (md) => md === '## section title' || 'got ' + JSON.stringify(md));

  await actionCase('Heading 1 then back to paragraph',
    async () => { await page.keyboard.type('was heading'); await page.selectOption('#heading-select', 'H1'); await page.selectOption('#heading-select', 'P'); },
    (md) => md === 'was heading' || 'got ' + JSON.stringify(md));

  await actionCase('bullet list, two items via Enter',
    async () => { await page.keyboard.type('first'); await page.click('[data-cmd="ul"]'); await page.click('#wysiwyg-editor'); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('second'); },
    (md) => md === '- first\n- second' || 'got ' + JSON.stringify(md));

  await actionCase('numbered list, two items via Enter',
    async () => { await page.keyboard.type('first'); await page.click('[data-cmd="ol"]'); await page.click('#wysiwyg-editor'); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('second'); },
    (md) => md === '1. first\n2. second' || 'got ' + JSON.stringify(md));

  await actionCase('nested list via Indent',
    async () => {
      await page.keyboard.type('parent'); await page.click('[data-cmd="ul"]');
      await page.click('#wysiwyg-editor'); await page.keyboard.press('End');
      await page.keyboard.press('Enter'); await page.keyboard.type('child');
      await page.click('[data-cmd="indent"]');
    },
    (md) => md === '- parent\n  - child' || 'got ' + JSON.stringify(md));

  await actionCase('checklist button + typing',
    async () => { await page.click('[data-cmd="checklist"]'); await page.keyboard.type('buy milk'); },
    (md) => md === '- [ ] buy milk' || 'got ' + JSON.stringify(md));

  await actionCase('Blockquote button',
    async () => { await page.keyboard.type('quoted words'); await page.click('[data-cmd="quote"]'); },
    (md) => md === '> quoted words' || 'got ' + JSON.stringify(md));

  await actionCase('Code block button',
    async () => { await page.keyboard.type('x = 1'); await page.click('[data-cmd="codeblock"]'); },
    (md) => md === '```\nx = 1\n```' || 'got ' + JSON.stringify(md));

  await actionCase('HR button after text',
    async () => { await page.keyboard.type('above'); await page.keyboard.press('End'); await page.click('[data-cmd="hr"]'); await page.keyboard.type('below'); },
    (md) => md === 'above\n\n---\n\nbelow' || 'got ' + JSON.stringify(md));

  await actionCase('Link button with selected text',
    async () => { await typeAndSelectAll('click here'); promptQueue = ['https://example.com']; await page.click('[data-cmd="link"]'); },
    (md) => md === '[click here](https://example.com)' || 'got ' + JSON.stringify(md));

  await actionCase('Link button, no selection',
    async () => { promptQueue = ['https://example.com']; await page.click('[data-cmd="link"]'); },
    (md) => md === '[https://example.com](https://example.com)' || 'got ' + JSON.stringify(md));

  await actionCase('Image by URL button',
    async () => { promptQueue = ['https://example.com/pic.png', 'a picture']; await page.click('[data-cmd="image"]'); },
    (md) => md === '![a picture](https://example.com/pic.png)' || 'got ' + JSON.stringify(md));

  await actionCase('Callout dropdown',
    async () => { await page.selectOption('#alert-select', 'TIP'); },
    (md) => md === '> [!TIP]\n> Add a note here.' || 'got ' + JSON.stringify(md));

  await actionCase('Table button 2x1',
    async () => { promptQueue = ['2', '1']; await page.click('[data-cmd="table"]'); },
    (md) => md.startsWith('| Header 1 | Header 2 |') || 'got ' + JSON.stringify(md));

  await actionCase('Footnote button',
    async () => { await page.keyboard.type('some text'); await page.click('[data-cmd="footnote"]'); },
    (md) => /some text\[\^1\]/.test(md) || 'got ' + JSON.stringify(md));

  await actionCase('bold inside list item',
    async () => {
      await page.keyboard.type('item'); await page.click('[data-cmd="ul"]');
      await selectSubstring('item'); await page.click('[data-cmd="bold"]');
    },
    (md) => md === '- **item**' || 'got ' + JSON.stringify(md));

  await actionCase('type, Enter, type, bold second line',
    async () => {
      await page.keyboard.type('line one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('line two');
      await selectSubstring('line two');
      await page.click('[data-cmd="bold"]');
    },
    (md) => md === 'line one  \n**line two**' || 'got ' + JSON.stringify(md));


  await actionCase('single Enter = GFM hard break',
    async () => { await page.keyboard.type('A'); await page.keyboard.press('Enter'); await page.keyboard.type('B'); },
    (md) => md === 'A  \nB' || 'got ' + JSON.stringify(md));

  await actionCase('code block with two lines',
    async () => {
      await page.keyboard.type('a'); await page.click('[data-cmd="codeblock"]');
      // Not '#wysiwyg-editor' here: a code block always gets a trailing
      // empty paragraph placed after it (so there's something to click
      // below the block, elsewhere in this suite's coverage), which
      // makes that paragraph - not the code block - the container's
      // last child. Clicking the container's own background would
      // land the cursor there instead of back in the code, so this
      // clicks the code block directly instead.
      await page.click('#wysiwyg-editor pre'); await page.keyboard.press('End');
      await page.keyboard.press('Enter'); await page.keyboard.type('b');
    },
    (md) => md === '```\na\nb\n```' || 'got ' + JSON.stringify(md));

  // A whole note lives in ONE <p> here - blank lines are <br><br>
  // inside it, not separate paragraphs - so "make this a code block"
  // used to convert the entire note, silently swallowing everything
  // written above the cursor. These three pin the line-scoped
  // behaviour that replaced it.
  await actionCase('code block below existing text leaves that text alone',
    async () => {
      await page.keyboard.type('intro');
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      await page.click('[data-cmd="codeblock"]');
      await page.keyboard.type('CODE');
    },
    (md) => md === 'intro\n\n```\nCODE\n```' || 'got ' + JSON.stringify(md));

  await actionCase('code block on the middle line keeps the lines around it',
    async () => {
      await page.keyboard.type('one'); await page.keyboard.press('Enter');
      await page.keyboard.type('two'); await page.keyboard.press('Enter');
      await page.keyboard.type('three');
      await selectSubstring('two');
      await page.keyboard.press('ArrowRight'); // collapse onto the middle line
      await page.click('[data-cmd="codeblock"]');
    },
    (md) => (/one/.test(md) && /three/.test(md) && /```\s*\ntwo\s*\n```/.test(md))
      || 'got ' + JSON.stringify(md));

  // A block holding nothing but blank lines walks to "\n\n\n", which a
  // trimmed "is this block empty" test read as empty - so several
  // Enters followed by the Code block button swallowed every blank
  // line into the block instead of giving an empty one.
  await actionCase('code block after several Enters is empty, not full of blank lines',
    async () => {
      for (let i = 0; i < 5; i++) await page.keyboard.press('Enter');
      await page.click('[data-cmd="codeblock"]');
    },
    (md) => md === '<br>\n<br>\n<br>\n<br>\n<br>\n\n```\n\n```' || 'got ' + JSON.stringify(md));

  await actionCase('several Enters after text, then a code block, keeps the text',
    async () => {
      await page.keyboard.type('some text');
      for (let i = 0; i < 5; i++) await page.keyboard.press('Enter');
      await page.click('[data-cmd="codeblock"]');
    },
    (md) => md === 'some text\n\n<br>\n<br>\n<br>\n\n\n```\n\n```' || 'got ' + JSON.stringify(md));

  await actionCase('double Enter escapes a code block and typing continues after it',
    async () => {
      await page.click('[data-cmd="codeblock"]');
      await page.keyboard.type('code');
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      await page.keyboard.type('after');
    },
    (md) => md === '```\ncode\n```\n\nafter' || 'got ' + JSON.stringify(md));

  await actionCase('exit list with double Enter',
    async () => {
      await page.keyboard.type('first'); await page.click('[data-cmd="ul"]');
      await page.click('#wysiwyg-editor'); await page.keyboard.press('End');
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      await page.keyboard.type('after');
    },
    (md) => md === '- first\n\nafter' || 'got ' + JSON.stringify(md));

  await actionCase('quote with bold via UI',
    async () => {
      await page.keyboard.type('a b');
      await selectSubstring('a');
      await page.click('[data-cmd="bold"]');
      await page.click('[data-cmd="quote"]');
    },
    (md) => md === '> **a** b' || 'got ' + JSON.stringify(md));

  console.log('=====================================');
  console.log('TOTAL PASS: ' + passCount + '   FAIL: ' + failures.length);
  if (failures.length) {
    console.log('FAILED CASES:');
    for (const f of failures) console.log(JSON.stringify(f, null, 1));
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
