# lm-detector 组件说明

本项目使用 [Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector) 的以下组件，保留其挑战生成和评分逻辑：

- `lmfpd-sdk@0.2.0+git.70159b7536a2` 由上游提交 `70159b7536a2` 的源码构建，包含弱相邻数字信号的评分修复。使用 Bun `1.4.4` 和锁文件中的 `fzstd@0.1.1`，沿用上游 `sdk/ts/build.ts` 的 JavaScript 打包参数，产物位于 `vendor/lmfpd-sdk/index.mjs`。[评分修复](https://github.com/Ikaleio/lm-detector/commit/33fb43f26670be0ed7817ab13e5c4c4731ccb76a)
- `lmfpd-data@0.0.1795066792725` 来自同一上游提交发布的 npm 包。`bundle.json` 保存为 `vendor/data/unified_bank.json`。压缩分片按清单顺序拼接并解压为 `vendor/data/shared_detector.bin`，解压后按清单核对 SHA-256。[npm 发布](https://www.npmjs.com/package/lmfpd-data/v/0.0.1795066792725)

各目录保留上游原始许可。SDK 内含 `fzstd`，其许可为 `vendor/lmfpd-sdk/fzstd.LICENSE`。固定版本、来源和 SHA-256 见 [vendor/provenance.json](vendor/provenance.json)。本项目为非官方项目。
