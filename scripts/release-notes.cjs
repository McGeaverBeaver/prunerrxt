#!/usr/bin/env node
/**
 * Release notes for one version, from the commits since the previous tag.
 *
 * Used by .github/workflows/release.yml on every push to main:
 *
 *   node scripts/release-notes.cjs --version 2.0.4 --previous v2.0.3 \
 *     --changelog CHANGELOG.md --out release-notes.md
 *
 * It prepends a section for the version to CHANGELOG.md (or completes a
 * hand-written section that already carries that heading, which is how the
 * first release of a new major or minor gets its prose), and writes the same
 * section on its own to --out for the GitHub release body. Merge commits and
 * the release commits themselves are left out of the list. Pass --dry-run to
 * print the section without touching any file.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

const version = arg('version');
const previous = arg('previous', '');
const changelogPath = arg('changelog', 'CHANGELOG.md');
const outPath = arg('out', '');
const dryRun = arg('dry-run', false) === true;
if (!version) {
  console.error('usage: release-notes.cjs --version X.Y.Z [--previous vX.Y.W] [--changelog CHANGELOG.md] [--out release-notes.md] [--dry-run]');
  process.exit(2);
}

const date = new Date().toISOString().slice(0, 10);
// Without a previous tag there is no meaningful range (it would be the whole
// history back to the fork), so the first release relies on its hand-written
// section alone.
const log = (previous ? execFileSync('git', ['log', '--no-merges', '--format=%s', `${previous}..HEAD`], { encoding: 'utf8' }) : '')
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s && !/^Release v?\d+\.\d+\.\d+/.test(s));

const seen = new Set();
const bullets = log.filter((s) => (seen.has(s) ? false : (seen.add(s), true))).map((s) => `- ${s}`);
const heading = `## ${version} (${date})`;

let changelog = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '# Changelog\n\n';
let section;

// A hand-written section for this exact version, not yet dated, is completed
// in place: its prose stays and the commit list follows it.
const pending = new RegExp(`^## ${version.replace(/\./g, '\\.')}(?: \\(unreleased\\))?[ \t]*$`, 'm');
const match = changelog.match(pending);
if (match) {
  const start = match.index;
  const bodyStart = start + match[0].length;
  const nextIdx = changelog.indexOf('\n## ', bodyStart);
  const body = changelog.slice(bodyStart, nextIdx === -1 ? changelog.length : nextIdx).replace(/\s+$/, '');
  const list = bullets.length > 0 ? `\n\n### Commits\n\n${bullets.join('\n')}` : '';
  section = `${heading}${body}${list}\n`;
  changelog = `${changelog.slice(0, start)}${section}\n${changelog.slice(nextIdx === -1 ? changelog.length : nextIdx + 1)}`;
} else {
  const list = bullets.length > 0 ? bullets.join('\n') : '- Rebuild with no code changes.';
  section = `${heading}\n\n${list}\n`;
  const firstSection = changelog.indexOf('\n## ');
  changelog = firstSection === -1 ? `${changelog.replace(/\s+$/, '')}\n\n${section}` : `${changelog.slice(0, firstSection + 1)}${section}\n${changelog.slice(firstSection + 1)}`;
}

if (dryRun) {
  process.stdout.write(section);
  process.exit(0);
}
fs.writeFileSync(changelogPath, changelog.replace(/\n{3,}/g, '\n\n'));
if (outPath) fs.writeFileSync(outPath, section);
console.log(`${changelogPath}: added ${version} (${bullets.length} commit(s))`);
