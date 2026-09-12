// 同步 public/index.html -> public/v5/index.html (CI/本地通用, 替代 python 版)
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('public/v5', { recursive: true });
copyFileSync('public/index.html', 'public/v5/index.html');
console.log('v5/index.html synced');
