// Documentation and harness structure checks for test/harness/structure/test-project-structure.sh.
// Prints one line per check: "PASS\t<description>" or "FAIL\t<description>\t<detail>".
// Run from the project root: node test/harness/structure/check-docs.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const results = [];
const check = (desc, ok, detail = '') => results.push(ok ? `PASS\t${desc}` : `FAIL\t${desc}\t${detail}`);
const read = path => readFileSync(path, 'utf8');
const lines = text => text.split('\n');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'cdk.out', 'test-results', 'playwright-report', '.git', 'coverage']);

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, filter, out);
    else if (filter(path)) out.push(path);
  }
  return out;
}

const REFERENCE_LAYERS = ['infrastructure', 'iac', 'frontend', 'ui', 'security', 'api', 'data'];

const BILINGUAL = [
  'README.md', 'CHANGELOG.md', 'docs/architecture.md', 'docs/onboarding.md', 'docs/api-reference.md',
  ...walk('docs/decisions', p => p.endsWith('.md')),
  ...walk('docs/runbooks', p => p.endsWith('.md')),
  ...walk('docs/reference', p => p.endsWith('.md')),
].filter((p, i, all) => all.indexOf(p) === i);

const CLAUDE_FILES = walk('.', p => p.endsWith('CLAUDE.md')).map(p => relative('.', p));

/** Split a bilingual document into its English and Korean halves (by the explicit anchors). */
function halves(text) {
  const en = text.indexOf('<a id="english"></a>');
  const ko = text.indexOf('<a id="korean"></a>');
  if (en < 0 || ko < 0 || ko < en) return null;
  return { english: text.slice(en, ko), korean: text.slice(ko) };
}

/** Fenced code blocks: [{ lang, body, line }]. Unterminated fences are reported as body null. */
function fences(text) {
  const out = [];
  let open = null;
  lines(text).forEach((line, i) => {
    const m = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (!m) { if (open) open.body.push(line); return; }
    if (!open) open = { marker: m[2], lang: m[3].trim(), body: [], line: i + 1 };
    else if (m[2].startsWith(open.marker[0]) && m[2].length >= open.marker.length && !m[3].trim()) {
      out.push({ lang: open.lang, body: open.body.join('\n'), line: open.line });
      open = null;
    } else open.body.push(line);
  });
  if (open) out.push({ lang: open.lang, body: null, line: open.line });
  return out;
}

const stripCode = text => text.replace(/^(\s*)(`{3,}|~{3,})[\s\S]*?^\1\2\s*$/gm, '').replace(/`[^`\n]*`/g, '');

// --- 1. Bilingual documents: toggle, anchors, order, parity, style ---
for (const file of BILINGUAL) {
  if (!existsSync(file)) { check(`${file}: exists`, false, 'missing'); continue; }
  const text = read(file);
  check(`${file}: HTML language toggle`, text.includes('<a href="#english">') && text.includes('<a href="#korean">'),
    'needs <a href="#english"><img ...></a> and <a href="#korean"><img ...></a>');
  const h = halves(text);
  check(`${file}: English section first, then Korean (explicit anchors)`, !!h, 'needs <a id="english"></a> before <a id="korean"></a>');
  if (h) {
    const heads = s => (stripCode(s).match(/^#{2,3} .+$/gm) ?? []).map(x => x.match(/^#+/)[0].length).join(',');
    check(`${file}: both languages have the same heading structure`, heads(h.english) === heads(h.korean),
      `EN ${heads(h.english)} vs KO ${heads(h.korean)}`);
    const fe = fences(h.english), fk = fences(h.korean);
    check(`${file}: both languages have the same number of code blocks`, fe.length === fk.length, `EN ${fe.length} vs KO ${fk.length}`);
    const mermaid = f => f.filter(b => b.lang === 'mermaid').map(b => b.body).join('\n----\n');
    check(`${file}: Mermaid diagrams are identical in both languages`, mermaid(fe) === mermaid(fk), 'diagram text differs');
    const hangulInEnglish = stripCode(h.english).replace(/<a href="#korean">.*?<\/a>/g, '').replace(/^.*(한국어|Korean).*$/gm, '')
      .match(/[가-힣]{2,}/g) ?? [];
    check(`${file}: English section is not left in Korean`, hangulInEnglish.length <= 6, `${hangulInEnglish.length} Hangul words, e.g. ${hangulInEnglish.slice(0, 3).join(' ')}`);
    const koreanProse = stripCode(h.korean).match(/[가-힣]+/g) ?? [];
    check(`${file}: Korean section is written in Korean`, koreanProse.length >= 10, `${koreanProse.length} Hangul words`);
  }
  const blocks = fences(text);
  const unlabeled = blocks.filter(b => !b.lang).map(b => b.line);
  check(`${file}: every code block names its language`, unlabeled.length === 0, `unlabeled fences at lines ${unlabeled.join(', ')}`);
  const unterminated = blocks.filter(b => b.body === null).map(b => b.line);
  check(`${file}: no unterminated code block`, unterminated.length === 0, `line ${unterminated.join(', ')}`);
  const emoji = text.match(/\p{Extended_Pictographic}/gu) ?? [];
  check(`${file}: no emoji`, emoji.length === 0, emoji.slice(0, 5).join(' '));
  const boxes = text.match(/[┌┐└┘├┤┬┴┼│─▶▼◀▲]/g) ?? [];
  check(`${file}: no ASCII box diagrams (use Mermaid)`, boxes.length === 0, `${boxes.length} box-drawing characters`);
  check(`${file}: no unfilled template placeholders`, !/<!-- *TODO|\{\{[A-Z_]+\}\}|<project_name>|<brief_architecture_description>/.test(text),
    (text.match(/<!-- *TODO[^>]*-->|\{\{[A-Z_]+\}\}|<project_name>/) ?? [''])[0]);
}

// --- 2. Emoji-free CLAUDE.md files ---
for (const file of CLAUDE_FILES) {
  const emoji = read(file).match(/\p{Extended_Pictographic}/gu) ?? [];
  check(`${file}: no emoji`, emoji.length === 0, emoji.slice(0, 5).join(' '));
}

// --- 3. Relative links resolve (README, CHANGELOG, docs/**, every CLAUDE.md, .claude/**) ---
const LINKED = [...new Set(['README.md', 'CHANGELOG.md', ...BILINGUAL, ...walk('docs', p => p.endsWith('.md')),
  ...CLAUDE_FILES, ...walk('.claude', p => p.endsWith('.md'))])].filter(existsSync);
for (const file of LINKED) {
  const broken = [];
  const text = stripCode(read(file));
  for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#|<)/.test(target)) continue;
    const path = normalize(join(dirname(file), decodeURIComponent(target.split('#')[0])));
    if (!path || !existsSync(path)) broken.push(target);
  }
  check(`${file}: relative links resolve`, broken.length === 0, broken.slice(0, 5).join(', '));
}

// --- 4. Implementation references (sync-docs contract) ---
for (const layer of REFERENCE_LAYERS) {
  const file = `docs/reference/${layer}.md`;
  if (!existsSync(file)) { check(`${file}: exists`, false, 'missing'); continue; }
  const text = read(file);
  for (const n of ['1. Overview', '2. Components', '3. Key Decisions', '4. Code Pointers', '5. Cross-references']) {
    check(`${file}: has "### ${n}"`, text.includes(`### ${n}`), 'section missing');
  }
  const pointerBlocks = [...text.matchAll(/### 4\. (?:Code Pointers|코드 포인터)([\s\S]*?)(?=\n### |\n<a id=|$)/g)].map(m => m[1]).join('\n');
  const paths = [...new Set(pointerBlocks.match(/[A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+/g) ?? [])].filter(p => p.includes('/'));
  const missing = paths.filter(p => !existsSync(p.replace(/:\d+$/, '')));
  check(`${file}: code pointers exist on disk (${paths.length})`, paths.length >= 3 && missing.length === 0,
    paths.length < 3 ? `only ${paths.length} pointers` : missing.slice(0, 5).join(', '));
}
if (existsSync('docs/reference/INDEX.md')) {
  const index = read('docs/reference/INDEX.md');
  const regions = [...index.matchAll(/<!-- AUTO-MANAGED:index -->([\s\S]*?)<!-- \/AUTO-MANAGED -->/g)].map(m => m[1]);
  check('docs/reference/INDEX.md: AUTO-MANAGED:index region in both languages', regions.length === 2, `${regions.length} regions`);
  for (const layer of REFERENCE_LAYERS) {
    check(`docs/reference/INDEX.md: lists ${layer}.md`, regions.every(r => r.includes(`(${layer}.md)`)), 'not linked in every region');
  }
}
if (existsSync('CLAUDE.md')) {
  const root = read('CLAUDE.md');
  const region = root.match(/<!-- AUTO-MANAGED:references -->([\s\S]*?)<!-- \/AUTO-MANAGED -->/);
  check('CLAUDE.md: AUTO-MANAGED:references region', !!region, 'markers missing');
  if (region) {
    for (const layer of REFERENCE_LAYERS) {
      check(`CLAUDE.md: references docs/reference/${layer}.md`, region[1].includes(`docs/reference/${layer}.md`), 'not linked');
    }
  }
}

// --- 5. README and CHANGELOG contracts ---
const pkg = JSON.parse(read('package.json'));
if (existsSync('README.md')) {
  const readme = read('README.md');
  const h = halves(readme);
  const EN = ['Overview', 'Features', 'Architecture', 'Prerequisites', 'Installation', 'Usage', 'Configuration',
    'Project Structure', 'Testing', 'API Documentation', 'Contributing', 'License', 'Contact'];
  const KO = ['개요', '주요 기능', '아키텍처', '사전 요구 사항', '설치 방법', '사용법', '환경 설정',
    '프로젝트 구조', '테스트', 'API 문서', '기여 방법', '라이선스', '연락처'];
  if (h) {
    const order = (section, names) => {
      const found = names.map(n => section.search(new RegExp(`^## ${n}\\s*$`, 'm')));
      return { missing: names.filter((_, i) => found[i] < 0), ordered: found.every((v, i) => i === 0 || v > found[i - 1]) };
    };
    const en = order(h.english, EN), ko = order(h.korean, KO);
    check('README.md: English sections present', en.missing.length === 0, en.missing.join(', '));
    check('README.md: English sections in template order', en.ordered, 'out of order');
    check('README.md: Korean sections present', ko.missing.length === 0, ko.missing.join(', '));
    check('README.md: Korean sections in template order', ko.ordered, 'out of order');
    for (const [name, section] of [['English', h.english], ['Korean', h.korean]]) {
      check(`README.md: ${name} features use "- **Name** — description"`, /^- \*\*[^*]+\*\* — \S/m.test(section), 'no em-dash feature line');
      check(`README.md: ${name} contributing shows Conventional Commits`, /feat: /.test(section) && /git checkout -b /.test(section) && /Pull Request/.test(section), 'missing 5-step flow');
      check(`README.md: ${name} links LICENSE`, /\]\(LICENSE\)/.test(section), 'no LICENSE link');
      check(`README.md: ${name} has a Configuration table`, /\| *(Variable|변수) *\| *(Description|설명) *\| *(Default|기본값) *\|/.test(section), 'Variable | Description | Default table missing');
    }
  }
  check('README.md: version badge matches package.json', readme.includes(`Version-${pkg.version}-`), `expected Version-${pkg.version}`);
  check('README.md: license badge', /img\.shields\.io\/badge\/License-/.test(readme), 'no License badge');
}
if (existsSync('CHANGELOG.md')) {
  const changelog = read('CHANGELOG.md');
  check('CHANGELOG.md: title is "# Changelog"', changelog.startsWith('# Changelog\n'), 'first line');
  check('CHANGELOG.md: English intro statement', changelog.includes('All notable changes to this project will be documented in this file.'), 'missing');
  check('CHANGELOG.md: Korean intro statement', changelog.includes('이 프로젝트의 모든 주요 변경 사항은 이 파일에 기록됩니다.'), 'missing');
  check('CHANGELOG.md: [Unreleased] in both languages', (changelog.match(/^## \[Unreleased\]$/gm) ?? []).length === 2, 'expected 2');
  const versions = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm)].map(m => m[1]);
  check('CHANGELOG.md: latest release matches package.json', versions[0] === pkg.version, `latest ${versions[0]} vs ${pkg.version}`);
  check('CHANGELOG.md: same releases in both languages', versions.length % 2 === 0
    && versions.slice(0, versions.length / 2).join() === versions.slice(versions.length / 2).join(), versions.join(', '));
  const cats = [...changelog.matchAll(/^### (.+)$/gm)].map(m => m[1].trim());
  check('CHANGELOG.md: category headings are the six English Keep a Changelog names',
    cats.every(c => ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'].includes(c)), cats.filter(c => !['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'].includes(c)).join(', '));
  const links = changelog.match(/^\[(Unreleased|\d+\.\d+\.\d+)\]: https:\/\/github\.com\/\S+$/gm) ?? [];
  check('CHANGELOG.md: reference links in both languages', links.length >= 4 && links.every(l => /\/(compare\/|releases\/tag\/)/.test(l)), `${links.length} links`);
}

// --- 6. Docker build context mirror ---
const dockerignore = lines(read('.dockerignore')).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const service = read('infra/lib/service.ts');
const block = service.match(/IMAGE_CONTEXT_EXCLUDE = \[([\s\S]*?)\];/);
const excludes = block ? [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
check('.dockerignore matches IMAGE_CONTEXT_EXCLUDE (same patterns, same order)',
  excludes.length > 0 && excludes.join('\n') === dockerignore.join('\n'),
  `only in .dockerignore: ${dockerignore.filter(x => !excludes.includes(x)).join(' ')} | only in service.ts: ${excludes.filter(x => !dockerignore.includes(x)).join(' ')}`);
for (const path of ['.claude', 'scripts', '.mcp.json', '.editorconfig', 'LICENSE', '**/*.md']) {
  check(`Docker build context excludes ${path}`, dockerignore.includes(path), 'add it to .dockerignore and IMAGE_CONTEXT_EXCLUDE');
}

for (const line of results) console.log(line);
