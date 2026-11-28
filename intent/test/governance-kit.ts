/**
 * Test-only signing: a generated Ed25519 key that signs exactly as ssh-keygen -Y sign does, and git commits signed
 * the way git signs them with gpg.format=ssh. Nothing here is used by the factory; it is how the tests act as a
 * person, and as an agent that holds the wrong key or none.
 */
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { commitSignature, ED25519, keyFromBlob, keyLine, signedData, sshString, SK_ED25519, type PublicKey } from '../src/governance/sshsig.ts';

export interface TestKey {
  readonly pub: PublicKey;
  readonly line: string;
  readonly sign: (message: Buffer | string, namespace: string) => string;
}

const armor = (blob: Buffer) => `-----BEGIN SSH SIGNATURE-----\n${blob.toString('base64').replace(/.{1,70}/g, '$&\n')}-----END SSH SIGNATURE-----\n`;

/** A fresh Ed25519 key. With `sk`, a security-key key whose signatures carry `flags` (0x01 is user presence). */
export function testKey(opts: { sk?: boolean; flags?: number } = {}): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const type = opts.sk ? SK_ED25519 : ED25519;
  const blob = Buffer.concat([sshString(type), sshString(raw), ...(opts.sk ? [sshString('ssh:')] : [])]);
  const pub = keyFromBlob(blob)!;
  return { pub, line: keyLine(pub, 'test@zthr'), sign: (m, ns) => sshsign(privateKey, pub, m, ns, opts.flags ?? 0x01) };
}

function sshsign(priv: KeyObject, pub: PublicKey, message: Buffer | string, namespace: string, flags: number): string {
  const data = signedData(namespace, 'sha512', message);
  let sigBlob: Buffer;
  if (pub.type === ED25519) sigBlob = Buffer.concat([sshString(ED25519), sshString(edSign(null, data, priv))]);
  else {
    const counter = Buffer.from([0, 0, 0, 7]);
    const inner = Buffer.concat([createHash('sha256').update(pub.application ?? '').digest(), Buffer.from([flags]), counter, createHash('sha256').update(data).digest()]);
    sigBlob = Buffer.concat([sshString(SK_ED25519), sshString(edSign(null, inner, priv)), Buffer.from([flags]), counter]);
  }
  return armor(Buffer.concat([Buffer.from('SSHSIG'), Buffer.from([0, 0, 0, 1]), sshString(pub.blob), sshString(namespace), sshString(''), sshString('sha512'), sshString(sigBlob)]));
}

/** A git repository for planted tests: commit as anyone, signed by a test key or not at all. */
export function testRepo(dir: string) {
  const git = (args: string[], input?: string) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', ...(input !== undefined ? { input } : {}) });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main']);
  /** Stage everything and commit; with a key, the commit carries an SSH signature made as git makes it. */
  const commit = (message: string, key?: TestKey, author = 'agent <agent@zthr>') => {
    git(['add', '-A']);
    const tree = git(['write-tree']);
    const parent = spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const stamp = `${author} 1764158400 +0000`;
    const head = `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${stamp}\ncommitter ${stamp}\n`;
    const payload = `${head}\n${message}\n`;
    let raw = payload;
    if (key) {
      const sig = key.sign(payload, 'git').trimEnd();
      raw = `${head}gpgsig ${sig.split('\n').join('\n ')}\n\n${message}\n`;
      if (commitSignature(raw).payload !== payload) throw new Error('kit: signed payload does not round-trip');
    }
    const sha = git(['hash-object', '-t', 'commit', '-w', '--stdin'], raw);
    git(['update-ref', 'HEAD', sha]);
    git(['reset', '-q', '--hard', sha]);
    return sha;
  };
  return { dir, git, commit };
}
