# 晨小屋 · 博客项目索引

> 本索引用于后续维护参考。站点：https://ruochenhua.github.io/

---

## 1. 项目概述

| 项目 | 说明 |
|------|------|
| **名称** | hexo-site（晨小屋） |
| **框架** | Hexo 7.x |
| **主题** | Fluid（`themes/fluid`，非 npm 包） |
| **部署** | GitHub Pages，仓库 `ruochenhua/ruochenhua.github.io`，分支 `master` |
| **语言** | zh-CN |

---

## 2. 技术栈与依赖

- **Hexo** 7.x + 本地 **Fluid** 主题
- **渲染**：hexo-renderer-markdown-it、hexo-math（KaTeX：`@traptitech/markdown-it-katex`）
- **生成器**：archive、category、tag、index
- **部署**：hexo-deployer-git
- **语法高亮**：highlight.js（站点配置）/ 主题内可切换 highlightjs、prismjs

---

## 3. 目录结构（核心）

```
blog_source/
├── _config.yml              # 站点主配置（URL、目录、写作、部署等）
├── _config - 副本.yml       # 配置备份
├── package.json             # 依赖与脚本
├── db.json                  # Hexo 生成的数据（可忽略版本）
├── source/
│   ├── _posts/              # 所有博文 .md（含同名资源文件夹）
│   ├── about/index.md       # 关于页
│   └── display-cabinet/index.md  # 展示窗页面（作品/ShaderToy/GitHub 等）
├── themes/fluid/            # Fluid 主题（含 _config.yml）
├── public/                  # hexo generate 输出（静态站）
└── .deploy_git/             # hexo deploy 使用的 git 副本
```

---

## 4. 关键配置摘要

### 4.1 站点 `_config.yml`

- **url**: `https://ruochenhua.github.io/`
- **permalink**: `:year/:month/:day/:title/`
- **post_asset_folder**: true（每篇文章可有同名资源文件夹）
- **theme**: fluid
- **language**: zh-CN
- **deploy**: type git, repo `https://github.com/ruochenhua/ruochenhua.github.io.git`, branch master
- **index_generator**: per_page 10, order_by -date

### 4.2 主题 `themes/fluid/_config.yml`

- 全局：favicon、代码块复制/高亮（highlightjs/prismjs）等
- 导航、页脚、评论、统计等均在主题配置中
- 详细说明见：https://hexo.fluid-dev.com/docs/guide/

---

## 5. 博文列表（source/_posts）

按文件名排序，便于定位与维护：

| 文件名 | 主题/方向 |
|--------|-----------|
| StartMyBlog.md | 开博 |
| ProceduralTerrainGeneration.md | 程序化地形 |
| ProceduralTerrainGeneration2.md | 程序化地形 2 |
| ProceduralTerrainGeneration2-optimize.md | 程序化地形优化 |
| defer-render.md | 延迟渲染 |
| depth-of-field.md | 景深 |
| single-scatter-atmosphere.md | 单次散射大气 |
| cascade-shadow-map.md | 级联阴影 |
| reflective-shadow-map.md | 反射阴影贴图 |
| screen-space-reflection.md | 屏幕空间反射 |
| soft-shadow.md | 软阴影 |
| digital-human-render-1~4.md | 数字人渲染系列 |
| ibl-diffuse-irradiance.md | IBL 漫反射 |
| ibl-specular.md | IBL 高光 |
| gerstner-wave.md | Gerstner 波 |
| water-effect-1.md / water-effect-2.md | 水面效果 |
| opengl-dsa.md | OpenGL DSA |
| vulkan-shadowmap.md | Vulkan 阴影 |
| vulkan-defer-render.md | Vulkan 延迟渲染 |
| kong-vulkan-intro.md | Kong/Vulkan 介绍 |
| ue-android-setup.md | UE 安卓环境 |
| ue-ai-texture-generation.md | UE AI 贴图 |
| UE-SceneViewExtension.md | UE 场景视图扩展 |
| ue-shader-globalshader.md | UE 全局 Shader |
| ue-shader-materialexpression.md | UE 材质表达式 |
| UE中的变体.md | UE 变体 |
| 虚幻引擎ScriptStruct简介.md | UE ScriptStruct |
| deepseek-local-deploy.md | DeepSeek 本地部署 |
| 基于GitLab-Runner的CI-CD构建.md | CI/CD |
| 显卡接口乌龙.md | 硬件/杂谈 |
| 新的起点.md | 生活杂谈 |

---

## 6. 常用命令

```bash
# 安装依赖
npm install

# 本地预览（默认 http://localhost:4000）
npm run server
# 或
hexo server

# 清理并生成静态文件
npm run clean && npm run build
# 或
hexo clean && hexo generate

# 部署到 GitHub Pages
npm run deploy
# 或
hexo deploy
```

---

## 7. 维护注意事项

1. **新文章**：在 `source/_posts/` 下新建 `.md`，front matter 需含 `title`、`date`、`tags`；若用 Fluid 首图可设 `index_img`、`banner_img`；资源可放在同名文件夹（post_asset_folder 已开启）。
2. **主题修改**：改 `themes/fluid/` 下文件即可；大版本升级建议先备份或使用 git submodule 管理 fluid。
3. **站点配置**：改 `_config.yml`；主题相关改 `themes/fluid/_config.yml`。
4. **关于/展示窗**：`source/about/index.md`、`source/display-cabinet/index.md`。
5. **部署**：确保 `hexo deploy` 前已配置好 Git 推送权限（如 GitHub token 或 SSH）；生成结果在 `public/`，实际推送的是 `.deploy_git` 指向的仓库。

---

*索引生成后，后续维护可据此快速定位配置、文章与结构。*
