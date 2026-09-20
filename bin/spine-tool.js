#!/usr/bin/env node
/**
 * spine-tool 可执行入口。
 * 逻辑全在 src/cli/main.js，这里只负责退出码。
 */

import { main } from '../src/cli/main.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`未捕获错误: ${err.stack ?? err}\n`);
    process.exitCode = 1;
  },
);
