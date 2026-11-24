# Third-party notices

`dsh-slick` 内嵌（vendored）了以下第三方代码，随本仓库一起分发。

## dsh-codex-effort-slider

- 来源：https://github.com/Microqian2th/dsh-codex-effort-slider
- 版本：1.1.9
- 许可证：MIT
- 版权：Copyright (c) Microqian2th
- 内嵌位置：`src/codex-slider.js`（构建时内联进 `client.js`）
- 用途：模型菜单「推理等级」那一行的 Codex 风格可拖动滑条

内嵌而非作为依赖，是为了让本插件自足——只启用 `dsh-slick` 一个插件即可获得滑条，
不需要再单独安装/启用第二个插件。

相对上游的唯一改动：**移除了行上的紫色内描边**（上游用
`row.style.boxShadow = "inset 0 0 0 1px rgba(168,85,247,…)"`，这里改成 `""`），
按使用者要求去掉该视觉。

该部分的 MIT 许可全文见仓库根目录 `LICENSE`。
