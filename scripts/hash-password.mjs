#!/usr/bin/env node
/**
 * Hash a password for AUTH_LOCAL_PASSWORD_HASH so the compose file never has
 * to carry the password itself.
 *
 *   node scripts/hash-password.mjs                # prompts, no echo
 *   node scripts/hash-password.mjs 'my password'  # from an argument
 *
 * Output: scrypt$N$r$p$<salt>$<hash> — paste it as the value of
 * AUTH_LOCAL_PASSWORD_HASH. In docker-compose.yml, escape each `$` as `$$`.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
import { stdin, stdout, argv, exit } from 'node:process';

const N = 16384;
const R = 8;
const P = 1;

function hash(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 32, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

function print(password) {
  if (!password) {
    console.error('Password must not be empty.');
    exit(1);
  }
  const value = hash(password);
  console.log(value);
  console.log('');
  console.log('In docker-compose.yml, double every $ sign:');
  console.log(`  AUTH_LOCAL_PASSWORD_HASH=${value.replace(/\$/g, '$$$$')}`);
}

const fromArg = argv[2];
if (fromArg !== undefined) {
  print(fromArg);
} else {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // Hide the typed characters.
  const write = rl._writeToOutput;
  rl._writeToOutput = function (text) {
    if (text.startsWith('Password')) write.call(this, text);
  };
  rl.question('Password: ', (answer) => {
    rl.close();
    stdout.write('\n');
    print(answer);
  });
}
