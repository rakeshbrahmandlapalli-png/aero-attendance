// Shared checks must exercise the requested PR checkout, never takeoff-ops.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

export const attendanceRoot = fileURLToPath(new URL('../', import.meta.url));
export const parkingRoot = fileURLToPath(new URL('../../Parking-Ops/', import.meta.url));
export function verifySharedCheckouts() {
  for (const cwd of [attendanceRoot, parkingRoot]) {
    const git = (...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
    assert.equal(git('branch', '--show-current'), 'attendance-integration', cwd + ': check out the PR branch first');
    git('merge-base', '--is-ancestor', 'origin/attendance-integration', 'HEAD');
    console.log(`${cwd}: attendance-integration @ ${git('rev-parse', '--short', 'HEAD')} (working files under test)`);
  }
}
export const readParking = path => fs.readFileSync(new URL(path, 'file://' + parkingRoot), 'utf8');
export const sdkSource = () => readParking('public/vendor/supabase-2.117.2.js');
