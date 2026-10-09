/**
 * Real Pulumi engine, local backend, and a deterministic fake registry.
 * This models docker-build's digest deletion without building/pushing to AWS.
 * Run with npm run test:lifecycle. Needs Pulumi (SST's installation is enough).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { managedImageTransform } from '../../src/image';

const root = path.resolve(__dirname, '../..');
const sstBin = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'sst/bin');
const pulumi = process.env.PULUMI_BIN ?? (fs.existsSync(path.join(sstBin, 'pulumi')) ? path.join(sstBin, 'pulumi') : 'pulumi');

const program = `const pulumi = require('@pulumi/pulumi');
class RegistryImage {
  async create(inputs) {
    require('fs').writeFileSync(inputs.manifest, inputs.digest);
    return { id: 'image-' + inputs.generation, outs: inputs };
  }
  async diff(id, olds, news) {
    return { changes: olds.generation !== news.generation, replaces: ['generation'] };
  }
  async delete(id, props) {
    require('fs').appendFileSync(props.manifest + '.deletes', id + '\\n');
    require('fs').rmSync(props.manifest, { force: true });
  }
}
new pulumi.dynamic.Resource(new RegistryImage(), 'Image', {
  generation: process.env.IMAGE_GENERATION,
  digest: 'sha256:same-content',
  manifest: process.env.IMAGE_MANIFEST,
}, { retainOnDelete: process.env.RETAIN_IMAGE === 'true' });
`;

describe('same-digest replacement in the Pulumi engine', () => {
  it.each([
    { name: 'unprotected', before: false, after: false, exists: false },
    { name: 'retained', before: true, after: true, exists: true },
    { name: 'retention-added-during-replacement', before: false, after: true, exists: false },
    { name: 'retention-persisted-before-replacement', before: false, after: true, exists: true, staged: true },
  ])('$name', ({ before, after, exists, staged }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-laravel-lifecycle-'));
    const backend = path.join(dir, 'state');
    fs.mkdirSync(backend);
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'Pulumi.yaml'), 'name: image-lifecycle\nruntime: nodejs\n');
    fs.writeFileSync(path.join(dir, 'index.js'), program);
    const manifest = path.join(dir, 'registry-manifest');
    const env = {
      ...process.env, PATH: `${sstBin}${path.delimiter}${process.env.PATH}`,
      PULUMI_BACKEND_URL: `file://${backend}`, PULUMI_CONFIG_PASSPHRASE: 'local-test',
      PULUMI_SKIP_UPDATE_CHECK: 'true', IMAGE_MANIFEST: manifest,
    };
    const run = (args: string[], extra = {}) => execFileSync(pulumi, args, { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', stdio: 'pipe' });
    try {
      run(['stack', 'init', 'test', '--non-interactive']);
      const opts: { retainOnDelete?: boolean } = {};
      managedImageTransform()( {}, opts, 'Image');
      expect(opts.retainOnDelete).toBe(true);
      run(['up', '--yes', '--skip-preview', '--non-interactive'], { IMAGE_GENERATION: '1', RETAIN_IMAGE: String(before && opts.retainOnDelete) });
      expect(fs.existsSync(manifest)).toBe(true);
      if (staged) run(['up', '--yes', '--skip-preview', '--non-interactive'], { IMAGE_GENERATION: '1', RETAIN_IMAGE: 'true' });
      run(['up', '--yes', '--skip-preview', '--non-interactive'], { IMAGE_GENERATION: '2', RETAIN_IMAGE: String(after && opts.retainOnDelete) });
      expect(fs.existsSync(manifest)).toBe(exists);
      expect(fs.existsSync(manifest + '.deletes')).toBe(!exists);
    } finally {
      // Everything created by this fixture lives here; no AWS resources exist.
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
