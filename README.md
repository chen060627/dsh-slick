# dsh-slick

**DeepSeek Harness 对话增强工具集** — 让输入框和模型菜单更顺手的一组小功能。

A kit of small, opinionated enhancements for the [DeepSeek Harness](https://github.com/deepseek-ai) Web GUI:
paste-to-file conversion, in-place image annotation, Enter-to-steer, and a Codex-style reasoning-effort slider.

> 非官方插件。与 DeepSeek 官方无关。

---

## 功能 / Features

| 功能 | 说明 |
| --- | --- |
| **表格粘贴转 Excel** | 粘贴 Tab 分隔、至少 2 行 × 2 列的表格时，自动存成真正的 `.xlsx` 附件，而不是一堆文字。 |
| **长文本转 txt** | 超过阈值（默认 500 字）的纯文本自动存成 `.txt` 附件，保持输入框清爽。阈值可调，0 表示关闭。 |
| **图片标注** | 点草稿里的图片缩略图打开标注编辑器：画笔、方框、圆圈、直线、箭头、橡皮擦；可移动、可缩放；滚轮缩放画布；撤销 / 重做 / 清空。保存后得到一张新图片。 |
| **Enter 插话发送** | 智能体运行中按 Enter 立即插话（steer），而不是排队等本轮结束。与「设置 → 通用 → 繁忙时的发送行为」是同一项。 |
| **推理等级滑条** | 把模型菜单里的「推理等级」那一行换成一条可拖动的连续滑条（Codex 风格）。开关可切回官方档位列表。 |
| **智能体团队协作** | 模型行右侧的 ⚡ 一键开 / 关团队协作，无需确认弹窗；开启时官方那一行开关会被隐藏，避免重复。 |

所有开关都在 **设置 → 增强工具集** 里，修改立即生效，并按浏览器保存。

### 官方模式 / 滑条模式

「推理等级用滑条」开关：

- **开**（默认）：模型菜单里是可拖动的滑条，模型行有 ⚡ 团队协作按钮。
- **关**：恢复官方原样——点「推理等级」进入官方档位列表，团队协作仍是官方开关。

---

## 安装 / Install

这是 DSH 的 **bundle 插件**（含 host 半 `index.js` 与 client 半 `client.js`）。

### 1. 放到本地

```bash
git clone https://github.com/Sam/dsh-slick.git
```

### 2. 挂到 profile

编辑你的 profile `<DSH_HOME>/profiles/desktop/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-slick": "link:/绝对路径/dsh-slick"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-slick"
      ]
    }
  }
}
```

然后在 profile 的 `node_modules` 下建一个链接（Windows 用 junction，其它平台用符号链接）指向仓库目录：

```powershell
# Windows
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-slick" -Target "C:\绝对路径\dsh-slick"
```

**完全退出并重开 DSH Desktop**（关窗口不够，要退出进程）后生效。

> ⚠️ 推理等级滑条依赖 [`dsh-codex-effort-slider`](https://github.com/Microqian2th/dsh-codex-effort-slider) 提供滑动控件本身；不装它时「推理等级用滑条」开关不起作用，其余功能不受影响。装上后建议把它加入 `bundles`。

---

## 从源码构建 / Build

`client.js` 是由 `src/format.js` + `src/client-body.js` 拼接生成的，不要手改。

```bash
node scripts/build.mjs
```

---

## 目录结构

```
index.js            host 半：系统提示词段落、/dsh-slick/* 路由（重启等）
client.js           生成的浏览器端 bundle（勿手改）
src/format.js       纯逻辑：表格识别、长文本判定、无依赖 XLSX 写出
src/client-body.js  浏览器端 UI：设置页、标注编辑器、模型菜单增强
scripts/build.mjs   构建脚本
locale/             zh / en 文案
docs/               插件详情页说明
icon.svg            插件图标
cordis.patch.yml    默认配置（阈值、自动发送）
```

---

## 开发

- 目标环境：DSH Desktop（Electron / Chromium），Node 18+。
- `client.js` 改动刷新页面即可生效；`index.js`（host 半）改动需要重启 DSH。

## License

[MIT](./LICENSE)
