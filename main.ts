// Token Radar, model radar-2 — the program that turns the sealed snapshot
// into the entry. Node 22, standard library only.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// Run from the repository root, with the kit's input/ beside it. The
// program reads /input/snapshot.json (or --input <file|directory>), scores
// every launch candidate with the model in lib/model.ts, and writes:
//
//   board.json    the ranked board the gate reads
//   data.js       the same board, as a script the dashboard reads offline
//   dashboard/    a copy of this repository's dashboard/
//   screenshots/  a copy of this repository's screenshots/
//   dossier.json  the judge's summary, built by vendor/makefun-board.ts
//
// The dashboard is a static page with no network: dashboard/index.html,
// dashboard/app.css and dashboard/app.js read data.js, which this program
// writes from the same board the gate reads.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

// The gate's caps, as this program enforces them before writing.
const DOSSIER_TEXT_BYTES = 65_536;
const SHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const DASH_LIMIT = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function die(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

/** The value of --name <value>, --name=<value>, or the fallback. */
function flag(name: string, fallback: string): string {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && i + 1 < argv.length) return argv[i + 1] ?? '';
    if (argv[i]?.startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return fallback;
}

/** Copy a directory's plain files into another, skipping dotfiles. */
function copyPlain(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

function main(): void {
  const given = flag('input', '/input');
  const snapshotPath = given.endsWith('.json') ? given : join(given, 'snapshot.json');
  if (!existsSync(snapshotPath)) {
    die(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
  }
  const out = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const problem = boardIssue(board, snapshot);
  if (problem !== null) die(`the model wrote a board the gate refuses: ${problem}`, 1);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(out, 'data.js'), dataScript(radar));

  const pageFiles = copyPlain(join(root, 'dashboard'), join(out, 'dashboard'));
  const shots = copyPlain(join(root, 'screenshots'), join(out, 'screenshots'));
  if (shots.length < 3) {
    die(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`, 1);
  }
  for (const name of shots) {
    if (!SHOT_NAME.test(name)) die(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`, 1);
  }

  writeFileSync(
    join(out, 'dossier.json'),
    buildDossier(out, { text_max_bytes: DOSSIER_TEXT_BYTES, screenshots: SHOT_LIMIT, dashboard: DASH_LIMIT }),
  );

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${pageFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
  );
}

main();
