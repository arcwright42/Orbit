import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { assembleContextPack, composeContextPack, importContextPack, loadContextPack, parseManifest, readSection, type Atom } from '../src/domains/context';

function atom(id: string, extra: Record<string, unknown> = {}) {
  return { id, address: 'guide.md#intro', taxonomy: 'world', situations: ['fresh'], purpose: 'width', runtime: 'any', order: 0, priority: 'core', ...extra };
}
function manifest(atoms = [atom('intro')], extra: Record<string, unknown> = {}) {
  return { name: 'onboarding', version: '1.0', taxonomy: 'world', files: [{ path: 'guide.md', role: 'orientation' }], atoms, ...extra };
}
function fixture(data = manifest()) {
  const directory = mkdtempSync(join(tmpdir(), 'orbit-context-')), pack = join(directory, 'pack'); mkdirSync(pack);
  writeFileSync(join(pack, 'guide.md'), '# Guide\n## Intro\nHello world\n### Detail\nDetails\n```md\n## Fake\n```\n## Next\nOther\n');
  writeFileSync(join(pack, 'manifest.yaml'), stringify(data));
  return { directory, pack, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('real YAML pack import copies declared files and composes full H2/H3 spans with provenance', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.pack, 'undeclared.txt'), 'Do not import');
    const imported = importContextPack(f.pack, join(f.directory, 'imported'));
    assert.throws(() => readFileSync(join(imported.directory, 'undeclared.txt')));
    const result = composeContextPack(imported, { situation: 'fresh', runtime: 'codex' });
    assert.equal(result.pieces.length, 1);
    assert.match(result.pieces[0].text, /### Detail/);
    assert.match(result.pieces[0].text, /## Fake/);
    assert.doesNotMatch(result.pieces[0].text, /Other/);
    assert.equal(result.pieces[0].source, 'library');
    assert.equal(result.pieces[0].realPath, join(imported.directory, 'guide.md'));
    assert.throws(() => importContextPack(f.pack, imported.directory), /EEXIST/);
    assert.equal(readSection(result.pieces[0].text, ['intro','detail']).startsWith('### Detail'), true);
  } finally { f.close(); }
});

test('selection algebra, requires closure, profile-only and order agree with upstream', () => {
  const f = fixture(manifest([
    atom('fresh', { order: 30, requires: ['dependency'] }),
    atom('dependency', { order: 90, situations: ['handover'], profile_only: true }),
    atom('handover', { order: 10, situations: ['handover'] }),
    atom('compact', { order: 20, situations: ['post-compaction'] }),
    atom('claude', { runtime: 'claude', order: 40 }),
  ]));
  try {
    const pack = loadContextPack(f.pack);
    const ids = (situation: 'fresh'|'handover'|'post-compaction') => composeContextPack(pack, { situation, runtime: 'codex' }).pieces.map(piece => piece.atomId);
    assert.deepEqual(ids('fresh'), ['fresh','dependency']); // authored order, not invented topological order
    assert.deepEqual(ids('handover'), ['handover','fresh','dependency']);
    assert.deepEqual(ids('post-compaction'), ['handover','compact']);
    assert(composeContextPack(pack, { situation: 'fresh', runtime: 'claude' }).pieces.some(piece => piece.atomId === 'claude'));
  } finally { f.close(); }
});

test('budgets report overage and ordered drop suggestions without deleting material', () => {
  const f = fixture(manifest([atom('core'), atom('optional', { priority: 'optional', order: 1 })]));
  try {
    const result = composeContextPack(loadContextPack(f.pack), { situation: 'fresh', runtime: 'codex', budgetTokens: 1 });
    assert.equal(result.pieces.length, 2);
    assert.equal(result.budget!.dropCandidates[0].atomId, 'optional');
    assert.equal(result.budget!.overageTokens, result.totalEstimatedTokens - 1);
    assert.equal(result.pieces[0].estimatedTokens, Math.ceil(Buffer.byteLength(result.pieces[0].text) / 4));
  } finally { f.close(); }
});

test('malformed YAML, taxonomy, typo fields, undeclared files, missing dependencies and cycles fail loudly', () => {
  assert.throws(() => parseManifest('name: [broken'));
  assert.throws(() => parseManifest('name: x\nname: y'));
  for (const data of [
    manifest([atom('one')], { taxonomy: 'unknown' }),
    manifest([atom('one', { require: ['two'] })]),
    manifest([atom('one', { address: 'undeclared.md' })]),
    manifest([atom('one', { requires: ['missing'] })]),
    manifest([atom('one', { requires: ['two'] }), atom('two', { requires: ['one'] })]),
    manifest([atom('one'), atom('one')]),
    manifest([atom('one', { address: 'guide.md#intro/detail/deeper' })]),
  ]) assert.throws(() => parseManifest(stringify(data)));
  const f = fixture(manifest([atom('one', { requires: ['two'] }), atom('two', { runtime: 'claude', situations: ['handover'] })]));
  try { assert.throws(() => composeContextPack(loadContextPack(f.pack), { situation: 'fresh', runtime: 'codex' }), /Dependency unavailable/); }
  finally { f.close(); }
});

test('paths, outside symlinks and dangling links are rejected, inside links retain real byte provenance', () => {
  for (const path of ['../secret.md','/tmp/secret.md','a/../secret.md','a\\secret.md','project:../secret.md']) {
    assert.throws(() => parseManifest(stringify(manifest([atom('one', { address: path })]))));
  }
  const f = fixture();
  try {
    writeFileSync(join(f.directory, 'secret.md'), 'private');
    rmSync(join(f.pack, 'guide.md'));
    symlinkSync('../secret.md', join(f.pack, 'guide.md'));
    assert.throws(() => loadContextPack(f.pack), /escapes/);
    rmSync(join(f.pack, 'guide.md'));
    symlinkSync('missing.md', join(f.pack, 'guide.md'));
    assert.throws(() => loadContextPack(f.pack), /Dangling/);
    rmSync(join(f.pack, 'guide.md'));
    writeFileSync(join(f.pack, 'actual.md'), '## Intro\nSafe');
    symlinkSync('actual.md', join(f.pack, 'guide.md'));
    assert.equal(composeContextPack(loadContextPack(f.pack), { situation: 'fresh', runtime: 'codex' }).pieces[0].realPath, realpathSync(join(f.pack, 'actual.md')));
  } finally { f.close(); }
});

test('section duplicate paths fail, fenced headings do not match, and H1 terminates H2', () => {
  assert.throws(() => readSection('## Intro\none\n## Intro\ntwo', ['intro']), /ambiguous/);
  assert.throws(() => readSection('```\n## Intro\n```', ['intro']), /missing/);
  assert.equal(readSection('## Intro\nHello\n# Next\nother', ['intro']), '## Intro\nHello');
  assert.throws(() => readSection('## Intro\nHello', ['absent']), /missing/);
});

test('named profiles retain authored phases and demand explicit project/mission/seat/slice selections', () => {
  const profile = { id: 'install', situations: ['fresh'], runtimes: ['codex'], phases: [
    { id: 'orientation', atoms: ['intro'] }, { id: 'work', context: ['project','mission','seat','slice'] },
  ] };
  const f = fixture(manifest([atom('intro')], { profiles: [profile] }));
  try {
    const root = join(f.directory, 'tree'); mkdirSync(root); writeFileSync(join(root, 'facts.md'), '## Facts\nActual context');
    const pack = loadContextPack(f.pack);
    assert.throws(() => composeContextPack(pack, { situation: 'fresh', runtime: 'codex', profileId: 'install' }), /explicit project/);
    const contextAtoms = Object.fromEntries(['project','mission','seat','slice'].map(source => [source, [atom(`${source}-facts`, { address: `${source === 'slice' ? 'project' : source}:facts.md#facts` }) as Atom]]));
    const result = composeContextPack(pack, { situation: 'fresh', runtime: 'codex', profileId: 'install', contextAtoms, roots: { project: root, mission: root, seat: root } });
    assert.deepEqual(result.phases!.map(phase => phase.id), ['orientation','work']);
    assert.deepEqual(result.pieces.map(piece => piece.atomId), ['intro','project-facts','mission-facts','seat-facts','slice-facts']);
    assert.equal(result.pieces.at(-1)!.source, 'project');
    assert.throws(() => composeContextPack(pack, { situation: 'fresh', runtime: 'claude', profileId: 'install' }), /incompatible/);
    assert.throws(() => composeContextPack(pack, { situation: 'fresh', runtime: 'codex', profileId: 'install', contextAtoms }), /configured project/);
    symlinkSync(join(f.pack, 'guide.md'), join(root, 'escape.md'));
    contextAtoms.project[0].address = 'project:escape.md';
    assert.throws(() => composeContextPack(pack, { situation: 'fresh', runtime: 'codex', profileId: 'install', contextAtoms, roots: { project: root, mission: root, seat: root } }), /escapes/);
  } finally { f.close(); }
});

test('profile dependencies must be in same or earlier phase; missing context dependency is not silently dropped', () => {
  const data = manifest([atom('base'), atom('dependent', { requires: ['base'] })], { profiles: [{ id: 'install', situations: ['fresh'], runtimes: ['codex'], phases: [{ id: 'first', atoms: ['dependent'] }, { id: 'second', atoms: ['base'] }] }] });
  assert.throws(() => parseManifest(stringify(data)), /same or earlier/);
});

test('post-compaction may skip only genuinely absent seat recap; handover, missing root and dangling recap fail', () => {
  const f = fixture(manifest([atom('recap', { address: 'seat:RECAP.md', situations: ['handover'] })]));
  try {
    const seat = join(f.directory, 'seat'); mkdirSync(seat); const pack = loadContextPack(f.pack);
    const compact = composeContextPack(pack, { situation: 'post-compaction', runtime: 'codex', roots: { seat } });
    assert.equal(compact.skipped[0].atomId, 'recap');
    assert.throws(() => composeContextPack(pack, { situation: 'handover', runtime: 'codex', roots: { seat } }), /absent/);
    assert.throws(() => composeContextPack(pack, { situation: 'post-compaction', runtime: 'codex' }), /configured/);
    symlinkSync('missing', join(seat, 'RECAP.md'));
    assert.throws(() => composeContextPack(pack, { situation: 'post-compaction', runtime: 'codex', roots: { seat } }), /Dangling/);
  } finally { f.close(); }
});


test('file-only packs assemble exact bytes in declared order and do not silently compose zero atoms', () => {
  const f = fixture(manifest([], { files: [{ path: 'guide.md', role: 'reference' }, { path: 'second.txt', role: 'note' }] }));
  try {
    writeFileSync(join(f.pack, 'second.txt'), 'second exact bytes\n');
    const pack = loadContextPack(f.pack), output = assembleContextPack(pack);
    assert.equal(output.text, readFileSync(join(f.pack, 'guide.md'), 'utf8') + '\n\nsecond exact bytes\n');
    assert.throws(() => composeContextPack(pack, { situation: 'fresh', runtime: 'codex' }), /assembleContextPack/);
    rmSync(join(f.pack, 'second.txt'));
    assert.throws(() => assembleContextPack(pack), /absent/);
  } finally { f.close(); }
});
