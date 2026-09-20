#!/usr/bin/env node
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

const ROOT = process.cwd();
dotenv.config({ path: join(ROOT, '.env') });

const SOURCE = join(ROOT, 'test_assets/test_role_arbg.png');
const OUTPUT_DIR = join(ROOT, 'output/generated/test_role_arbg');
const IMAGES_DIR = join(OUTPUT_DIR, 'images');
const LOG_FILE = join(ROOT, 'output/_improve_log.jsonl');
const MAX_ITER = 50;

if (!existsSync(SOURCE)) { console.error('找不到源图:', SOURCE); process.exit(1); }
if (!process.env.ANTHROPIC_API_KEY) { console.error('缺少 ANTHROPIC_API_KEY'); process.exit(1); }

let iteration = 1;
let config = { margin: 4, bleed: 2, snap: true, prompt: '老太太生气的样子，挥着剪刀' };

if (existsSync(LOG_FILE)) {
  const lines = readFileSync(LOG_FILE, 'utf-8').trim().split('\n').filter(Boolean);
  if (lines.length) {
    const last = JSON.parse(lines[lines.length - 1]);
    iteration = last.iteration + 1;
    config = last.nextConfig || config;
    console.log(`\n从第 ${iteration} 轮继续（上次: ${last.score.toFixed(1)}）\n`);
  }
}

if (iteration > MAX_ITER) { console.log('已达 50 次'); process.exit(0); }

async function runGenerate() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['server/generate-cli.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        SOURCE_IMAGE: SOURCE,
        PROMPT: config.prompt,
        MARGIN: String(config.margin),
        BLEED: String(config.bleed),
        SNAP: config.snap ? '1' : '0'
      }
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; process.stdout.write(d); });
    proc.stderr.on('data', d => { err += d; process.stderr.write(d); });
    proc.on('close', code => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`生成失败: ${code}\n${err}`));
    });
  });
}

async function evalQuality() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['scripts/quality-eval.mjs', IMAGES_DIR], { cwd: ROOT });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('评分失败'));
      const m = out.match(/综合质量分:\s*([\d.]+)/);
      if (!m) return reject(new Error('无法解析质量分'));
      resolve({ score: parseFloat(m[1]), output: out });
    });
  });
}

function decideNextConfig(current, score, iter) {
  const next = { ...current };
  
  if (score < 60) {
    next.margin = Math.min(current.margin + 3, 12);
  } else if (score < 75) {
    next.margin = Math.min(current.margin + 2, 10);
  } else if (score < 85) {
    next.margin = Math.min(current.margin + 1, 8);
  }
  
  if (iter % 10 === 5 && current.snap) {
    next.snap = false;
    console.log(`\n[策略] 第 ${iter} 轮尝试关闭剪影吸附\n`);
  } else if (iter % 10 === 0 && !current.snap) {
    next.snap = true;
  }
  
  return next;
}

console.log(`\n=== 第 ${iteration}/${MAX_ITER} 轮 ===`);
console.log(`配置: margin=${config.margin} bleed=${config.bleed} snap=${config.snap}\n`);

try {
  console.log('[1/2] AI 生成...');
  await runGenerate();
  
  if (!existsSync(IMAGES_DIR)) throw new Error('生成未产出切图');
  
  console.log('\n[2/2] 质量评估...');
  const { score, output } = await evalQuality();
  console.log(output);
  
  const record = {
    iteration,
    timestamp: new Date().toISOString(),
    config,
    score,
    nextConfig: decideNextConfig(config, score, iteration)
  };
  
  mkdirSync(join(ROOT, 'output'), { recursive: true });
  writeFileSync(LOG_FILE, JSON.stringify(record) + '\n', { flag: 'a' });
  
  if (score >= 85) {
    console.log(`\n✓ 质量分 ${score.toFixed(1)} 已达标！`);
    console.log(`总共 ${iteration} 次`);
    console.log(`最终: margin=${config.margin} bleed=${config.bleed} snap=${config.snap}`);
    process.exit(0);
  }
  
  if (iteration >= MAX_ITER) {
    console.log(`\n已达最大迭代，最终: ${score.toFixed(1)}`);
    process.exit(0);
  }
  
  console.log(`\n下一轮: margin ${config.margin} → ${record.nextConfig.margin}`);
  console.log('运行 node scripts/auto-improve.mjs 继续\n');
  
} catch (err) {
  console.error('\n✗', err.message);
  process.exit(1);
}
