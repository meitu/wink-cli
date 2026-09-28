"use strict";

console.error("仓库根包 wink-cli 用于兼容已上架的旧安装器，禁止直接发布到 npm。请运行 npm run publish:npm（或先 npm run pack:npm，再 npm publish dist/meitu-wink-cli-<版本>.tgz --access public --registry=https://registry.npmjs.org/）。根目录 package.json 不要改成 meitu-wink-cli。");
process.exitCode = 1;
