import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import type { BrandContext, EditRequest, GenerateRequest } from '@scenri/core';
import { createCodexEngine } from '../src/index.js';

const PNG_1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 1, 1]);
const PNG_2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2, 2, 2]);

const brand: BrandContext = { brand: {}, assetPaths: {} };

const genReq: GenerateRequest = {
  prompt: 'a fox mascot on a teal background',
  brand,
  width: 640,
  height: 480,
  count: 2,
};

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

interface SpawnCall {
  cmd: string;
  args: string[];
  child: FakeChild;
}

/** Build a fake spawnImpl; `onSpawn` runs on the next tick so listeners attach first. */
function fakeSpawn(onSpawn: (call: SpawnCall) => void): {
  spawnImpl: typeof spawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnImpl = ((cmd: string, args: string[]) => {
    const call: SpawnCall = { cmd, args, child: new FakeChild() };
    calls.push(call);
    setTimeout(() => onSpawn(call), 0);
    return call.child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls };
}

function dirFromArgs(args: string[]): string {
  const i = args.indexOf('-C');
  expect(i).toBeGreaterThan(-1);
  return args[i + 1];
}

function newSaveImage() {
  let n = 0;
  return vi.fn((_buf: Buffer) => `hash-${++n}`);
}

describe('capabilities / costEstimate', () => {
  it('reports the locked codex-cli capabilities', () => {
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage() });
    expect(engine.capabilities()).toEqual({
      id: 'codex-cli',
      displayName: 'Codex CLI',
      localOnly: true,
      supportsEdit: true,
      supportsMask: false,
      maxReferenceImages: 6,
    });
  });

  it('costEstimate is always 0', async () => {
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage() });
    await expect(engine.costEstimate(genReq)).resolves.toBe(0);
  });
});

describe('isAvailable', () => {
  // Two questions with two different fixes: install, and sign in. The setup
  // wizard switches on `code`, so these three cases are its whole contract.
  it('asks --version then login status, and reports ready when both exit 0', async () => {
    const { spawnImpl, calls } = fakeSpawn(({ child }) => child.emit('exit', 0, null));
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    await expect(engine.isAvailable()).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe('codex');
    expect(calls[0].args).toEqual(['--version']);
    expect(calls[1].args).toEqual(['login', 'status']);
  });

  it('reports not-installed on ENOENT, without asking about the session', async () => {
    const { spawnImpl, calls } = fakeSpawn(({ child }) => {
      const err = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      child.emit('error', err);
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    await expect(engine.isAvailable()).resolves.toEqual({
      ok: false,
      reason: 'Codex CLI is not installed on this computer',
      code: 'not-installed',
    });
    expect(calls).toHaveLength(1);
  });

  it('reports not-installed when --version exits nonzero', async () => {
    const { spawnImpl } = fakeSpawn(({ child }) => child.emit('exit', 1, null));
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    await expect(engine.isAvailable()).resolves.toEqual({
      ok: false,
      reason: 'Codex CLI is not installed on this computer',
      code: 'not-installed',
    });
  });

  it('reports not-authenticated when the binary is there but the session is not', async () => {
    const { spawnImpl, calls } = fakeSpawn(({ args, child }) => {
      child.emit('exit', args[0] === '--version' ? 0 : 1, null);
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    await expect(engine.isAvailable()).resolves.toEqual({
      ok: false,
      reason: 'Codex CLI is installed but not signed in',
      code: 'not-authenticated',
    });
    expect(calls.map((c) => c.args)).toEqual([['--version'], ['login', 'status']]);
  });

  it('SCENRI_NO_CODEX=1 reports not-installed without spawning anything', async () => {
    // The e2e harness sets this so a machine's real codex login can never turn
    // a deterministic test run into a real build.
    vi.stubEnv('SCENRI_NO_CODEX', '1');
    try {
      const { spawnImpl, calls } = fakeSpawn(({ child }) => child.emit('exit', 0, null));
      const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
      await expect(engine.isAvailable()).resolves.toEqual({
        ok: false,
        reason: 'Codex CLI is not installed on this computer',
        code: 'not-installed',
      });
      expect(calls).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('generate', () => {
  it('runs one codex exec per image with low reasoning, collects hashes in order', async () => {
    let n = 0;
    const { spawnImpl, calls } = fakeSpawn(({ args, child }) => {
      const dir = dirFromArgs(args);
      writeFileSync(join(dir, 'out-1.png'), n++ === 0 ? PNG_1 : PNG_2);
      child.emit('exit', 0, null);
    });
    const saveImage = newSaveImage();
    const engine = createCodexEngine({ platform: 'linux', saveImage, spawnImpl });

    const result = await engine.generate(genReq); // count: 2 → two parallel execs

    expect(calls).toHaveLength(2);
    for (const { cmd, args } of calls) {
      expect(cmd).toBe('codex');
      expect(args.slice(0, 4)).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write']);
      expect(args).toContain('model_reasoning_effort="low"');
      const promptText = args[args.indexOf('-C') + 2];
      expect(promptText).toContain('Generate one flawless, professional-grade image immediately');
      expect(promptText).toContain('640x480: a fox mascot on a teal background');
      expect(promptText).toContain('Save the image in the current directory as out-1.png');
    }
    // second run is asked for a distinct composition
    const prompts = calls.map(({ args }) => args[args.indexOf('-C') + 2]);
    expect(prompts.filter((p) => p.includes('variant 2'))).toHaveLength(1);
    // distinct workdirs, both cleaned up
    const dirs = calls.map(({ args }) => dirFromArgs(args));
    expect(new Set(dirs).size).toBe(2);
    for (const d of dirs) expect(existsSync(d)).toBe(false);

    expect(saveImage).toHaveBeenCalledTimes(2);
    expect(result.costUsd).toBe(0);
    expect(result.images.slice().sort()).toEqual(['hash-1', 'hash-2']); // parallel workers — arrival order varies
  });

  // The adapter deliberately says nothing about the brand: compileBrief owns
  // every brand directive now, so what the composer previews is byte-for-byte
  // what the engine receives — and an off-brand shot stays off-brand, which it
  // could not while this adapter re-injected the kit behind the compiler's back.
  it('adds no brand text of its own — the compiled prompt is the whole prompt', async () => {
    const { spawnImpl, calls } = fakeSpawn(({ args, child }) => {
      writeFileSync(join(dirFromArgs(args), 'out-1.png'), PNG_1);
      child.emit('exit', 0, null);
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    await engine.generate({
      ...genReq,
      count: 1,
      brand: {
        assetPaths: {},
        brand: {
          specVersion: '0.1',
          meta: { name: 'Acme', tagline: 'Slow mornings' },
          palette: { primary: { hex: '#1F3D2B' }, accent: [{ hex: '#D96C3B' }] },
          imagery: { mood: 'crafted, tactile', keywords: ['warm daylight'], avoid: ['neon'] },
        },
      },
    });
    const p1 = calls[0].args[calls[0].args.indexOf('-C') + 2];
    expect(p1).not.toContain('Brand style');
    expect(p1).not.toContain('#1F3D2B');
    expect(p1).not.toContain('Slow mornings');
    expect(p1).toContain(genReq.prompt);
  });

  it('describes an attached brand mark as something to reproduce, not merely to sample', async () => {
    const { spawnImpl, calls } = fakeSpawn(({ args, child }) => {
      writeFileSync(join(dirFromArgs(args), 'out-1.png'), PNG_1);
      child.emit('exit', 0, null);
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    const srcDir = mkdtempSync(join(tmpdir(), 'codex-mark-'));
    const markPath = join(srcDir, 'wordmark.png');
    writeFileSync(markPath, PNG_1);
    await engine.generate({
      ...genReq,
      count: 1,
      referenceImages: [markPath],
      referenceRoles: ['brand'],
    });
    const p1 = calls[0].args[calls[0].args.length - 1]; // prompt is the positional tail
    expect(p1).toContain("the brand's own mark");
    expect(p1).toContain('reproduce it exactly as drawn');
  });

  it('passes referenceImages[0] via --image and adds the fidelity directive', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'codex-ref-'));
    const refPath = join(srcDir, 'product.png');
    writeFileSync(refPath, PNG_1);
    const { spawnImpl, calls } = fakeSpawn(({ args, child }) => {
      writeFileSync(join(dirFromArgs(args), 'out-1.png'), PNG_2);
      child.emit('exit', 0, null);
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    await engine.generate({
      ...genReq,
      count: 1,
      referenceImages: [refPath],
      referenceRoles: ['product'],
    });
    const args = calls[0].args;
    // References are copied under a neutral, positional name: the generate
    // prompt binds them by order ("Attached image 1 is ..."), not by filename,
    // and they are no longer all products.
    expect(args).toContain(`--image=${join(dirFromArgs(args), 'ref-0.png')}`);
    expect(args[args.length - 1]).not.toContain('--image'); // prompt stays the positional tail
    const promptText = args[args.length - 1];
    expect(promptText).toContain('preserve its label, shape, colors and design faithfully');
  });

  it('describes a role-less reference neutrally rather than claiming it is the product', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'codex-ref-'));
    const refPath = join(srcDir, 'ref.png');
    writeFileSync(refPath, PNG_1);
    const { spawnImpl, calls } = fakeSpawn(({ args, child }) => {
      writeFileSync(join(dirFromArgs(args), 'out-1.png'), PNG_2);
      child.emit('exit', 0, null);
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    // No roles supplied. Guessing "product" here is how a presenter's face ends
    // up described as a product to preserve the label and design of.
    await engine.generate({ ...genReq, count: 1, referenceImages: [refPath] });
    const promptText = calls[0].args[calls[0].args.length - 1];
    expect(promptText).toContain('a reference to match in composition, lighting and treatment');
    expect(promptText).not.toContain('the exact product');
  });

  // The batch used to reject when one parallel run failed, which threw away
  // pictures that were already saved in the content store. The images that did
  // arrive are the user's; only a run that produced nothing is a failure.
  it('keeps the images that arrived when one parallel run fails', async () => {
    let n = 0;
    const { spawnImpl } = fakeSpawn(({ args, child }) => {
      if (n++ === 0) {
        writeFileSync(join(dirFromArgs(args), 'out-1.png'), PNG_1);
        child.emit('exit', 0, null);
      } else {
        child.stderr.emit('data', 'image tool unavailable');
        child.emit('exit', 1, null);
      }
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    const result = await engine.generate(genReq);
    expect(result.images).toEqual(['hash-1']);
    expect(result.costUsd).toBe(0);
  });

  it('throws a clear error when codex exits 0 without producing images', async () => {
    const { spawnImpl } = fakeSpawn(({ child }) => child.emit('exit', 0, null));
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    await expect(engine.generate(genReq)).rejects.toThrow('Codex finished but produced no images');
  });

  it('throws with exit code and stderr snippet on nonzero exit', async () => {
    const { spawnImpl } = fakeSpawn(({ child }) => {
      child.stderr.emit('data', Buffer.from('not signed in'));
      child.emit('exit', 3, null);
    });
    const saveImage = newSaveImage();
    const engine = createCodexEngine({ platform: 'linux', saveImage, spawnImpl });
    await expect(engine.generate(genReq)).rejects.toThrow(/codex exited with code 3: not signed in/);
    expect(saveImage).not.toHaveBeenCalled();
  });

  // A four variant run that lost one image used to lose all four: the failed
  // worker rejected the batch while the finished pictures were already in the
  // content store, orphaned and unreachable.
  it('keeps the variants that succeeded when one of them fails', async () => {
    let n = 0;
    const { spawnImpl } = fakeSpawn(({ args, child }) => {
      if (n++ === 0) {
        child.stderr.emit('data', Buffer.from('rate limited'));
        child.emit('exit', 3, null);
        return;
      }
      writeFileSync(join(dirFromArgs(args), 'out-1.png'), PNG_2);
      child.emit('exit', 0, null);
    });
    const saveImage = newSaveImage();
    const engine = createCodexEngine({ platform: 'linux', saveImage, spawnImpl });

    const result = await engine.generate({ ...genReq, count: 3 });

    expect(result.images).toHaveLength(2);
    expect(result.costUsd).toBe(0);
  });

  it('still throws when every variant fails, so the node carries the reason', async () => {
    const { spawnImpl } = fakeSpawn(({ child }) => {
      child.stderr.emit('data', Buffer.from('not signed in'));
      child.emit('exit', 3, null);
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    await expect(engine.generate({ ...genReq, count: 2 })).rejects.toThrow(/not signed in/);
  });

  it('kills the child and throws after timeoutMs when codex never exits', async () => {
    const { spawnImpl, calls } = fakeSpawn(() => {
      /* never exits */
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl, timeoutMs: 50 });
    await expect(engine.generate(genReq)).rejects.toThrow('Codex CLI timed out after 50ms');
    expect(calls[0].child.kill).toHaveBeenCalled();
  });
});

describe('edit', () => {
  it('copies sourceImage to input.png, sends the edit prompt, returns the hash', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'codex-test-src-'));
    const sourceImage = join(srcDir, 'photo.png');
    writeFileSync(sourceImage, PNG_1);

    let inputBytes: Buffer | undefined;
    const { spawnImpl, calls } = fakeSpawn(({ args, child }) => {
      const dir = dirFromArgs(args);
      void readFile(join(dir, 'input.png')).then((buf) => {
        inputBytes = buf;
        writeFileSync(join(dir, 'out-1.png'), PNG_2);
        child.emit('exit', 0, null);
      });
    });
    const saveImage = newSaveImage();
    const engine = createCodexEngine({ platform: 'linux', saveImage, spawnImpl });

    const req: EditRequest = { instruction: 'make the sky teal', sourceImage, brand };
    const result = await engine.edit(req);

    const { cmd, args } = calls[0];
    expect(cmd).toBe('codex');
    expect(args.slice(0, 4)).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write']);
    expect(args[args.length - 1]).toBe(
      'Edit input.png using your image generation/editing tool: make the sky teal.' +
        ' Do not browse the web or explore files. Save the result in the current directory as out-1.png' +
        ' (you may run the commands needed to save and resize it). Nothing else.',
    );
    expect(inputBytes?.equals(PNG_1)).toBe(true);
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(saveImage.mock.calls[0][0].equals(PNG_2)).toBe(true);
    expect(result).toEqual({ images: ['hash-1'], costUsd: 0 });
  });

  // The edit path used to only copy the source into the working directory and
  // mention it in prose, so whether the model ever looked at the picture
  // depended on the skill going and finding the file. Generate has always
  // handed its references over with --image.
  it('hands the source over as a real image input, source first', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'codex-test-src-'));
    const sourceImage = join(srcDir, 'photo.png');
    const ref = join(srcDir, 'ref.png');
    writeFileSync(sourceImage, PNG_1);
    writeFileSync(ref, PNG_2);

    const { spawnImpl, calls } = fakeSpawn(({ args, child }) => {
      writeFileSync(join(dirFromArgs(args), 'out-1.png'), PNG_2);
      child.emit('exit', 0, null);
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });

    await engine.edit({
      instruction: 'remove the cup',
      sourceImage,
      brand,
      referenceImages: [ref],
      referenceRoles: ['product'],
    });

    const images = calls[0].args.filter((a) => a.startsWith('--image='));
    expect(images).toHaveLength(2);
    expect(images[0]).toContain('input.png');
    expect(images[1]).toContain('product-1.png');
    // the prompt is still the positional tail
    expect(calls[0].args[calls[0].args.length - 1]).toContain('Edit input.png');
  });

  // A reference that arrives without a role is not a product. Calling it one
  // told the model to preserve the "label, shape and design" of a face.
  it('describes an unroled reference as a reference, never as the product', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'codex-test-src-'));
    const sourceImage = join(srcDir, 'photo.png');
    const ref = join(srcDir, 'ref.png');
    writeFileSync(sourceImage, PNG_1);
    writeFileSync(ref, PNG_2);

    const { spawnImpl, calls } = fakeSpawn(({ args, child }) => {
      writeFileSync(join(dirFromArgs(args), 'out-1.png'), PNG_2);
      child.emit('exit', 0, null);
    });
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });

    await engine.edit({ instruction: 'warmer light', sourceImage, brand, referenceImages: [ref] });

    const promptText = calls[0].args[calls[0].args.length - 1];
    expect(promptText).toContain('reference-1.png');
    expect(promptText).not.toContain('product-1.png');
    expect(promptText).not.toContain('the exact product');
  });

  it('propagates a clear error when codex exits 0 without out-1.png', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'codex-test-src-'));
    const sourceImage = join(srcDir, 'photo.png');
    writeFileSync(sourceImage, PNG_1);

    const { spawnImpl } = fakeSpawn(({ child }) => child.emit('exit', 0, null));
    const engine = createCodexEngine({ platform: 'linux', saveImage: newSaveImage(), spawnImpl });
    await expect(engine.edit({ instruction: 'x', sourceImage, brand })).rejects.toThrow(
      'Codex finished but produced no images',
    );
  });
});
