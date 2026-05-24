---
title: AetherEngine：从 KongEngine 到 Rust + wgpu 的现代渲染引擎重构
date: 2026-05-24 12:00:00
categories:
  - 技术漫谈
tags: [3D, render, Rust, wgpu, 编程, 引擎]
index_img: /2026/05/24/aether-engine-intro/aether_cover.png
banner_img: /2026/05/24/aether-engine-intro/aether_banner.png
---

写了十年引擎，还在画三角形——这话放在我身上挺合适的。

KongEngine 是我用 C++ 和 OpenGL/Vulkan 写的个人渲染引擎，延迟渲染、级联阴影、SSR、水体这些效果都折腾过一遍，也写了不少文章记录。但说实话，C++ 那套东西越往后越累：模板报错能看半天，头文件改一处编译五分钟，手动管理 GPU 资源时不时漏个释放，内存泄漏查起来要命。更别提让 AI 帮忙写代码了——C++ 的宏魔法和复杂语法让 AI 生成的代码经常编译不过，改来改去还不如自己写。

正好这两年 Rust 在图形领域慢慢起来了，wgpu 提供了跨平台的统一渲染抽象，hecs 是个极简的 ECS 实现。想了想，干脆用现代架构和 Rust 重新搭一个引擎，AetherEngine 就这么立项了。

## 为什么重写

KongEngine 代码量上来之后，几个坑越来越深：

1. **编译慢得离谱**。改一行头文件，等五分钟编译，这谁受得了。
2. **内存泄漏查起来要命**。手动管 GPU 资源，几次忘了释放，查半天才发现是某个纹理没删。
3. **AI 写 C++ 太费劲**。宏魔法和复杂语法让 AI 生成的代码经常编译不过，改来改去还不如自己写。Rust 的编译器友好很多，AI 生成通过率明显高一截。
4. **平台适配烦**。OpenGL 驱动差异大，Vulkan 样板代码太多。wgpu 底层自动选后端，一套代码跑全平台，省事。

说白了，我需要**编译快、内存安全、AI 友好、跨平台**的技术栈。Rust + wgpu 刚好对上。

## 技术选型

| 模块 | KongEngine | AetherEngine | 理由 |
|------|-----------|-------------|------|
| 语言 | C++ | Rust | 内存安全、编译器友好、包管理完善 |
| 渲染 API | OpenGL / Vulkan | wgpu | 单一后端自动适配 Vulkan/Metal/DX12 |
| ECS | 手写 | hecs | API 极简，无宏魔法，AI 友好 |
| 着色器 | GLSL / SPIR-V | WGSL | 统一语法，无需预编译脚本 |
| 场景格式 | JSON | RON | Rust 原生，类型安全 |
| UI | ImGui | egui | 即时模式，Rust 生态原生支持 |
| 构建系统 | CMake | Cargo | 依赖管理简单，增量编译快 |

wgpu 的选择挺关键的。它基于 WebGPU 标准，底层自动选 Vulkan（Windows/Linux）、Metal（macOS/iOS）或 DX12（Windows），一套代码跑所有平台。个人项目最怕平台适配折腾，wgpu 把这事儿省了。

## 架构设计

AetherEngine 采用 **ECS + RenderGraph** 的架构。ECS 用 hecs，没有 derive 宏，没有复杂 trait 约束，就是简单的 `World::spawn` 和 `Query`，AI 生成代码时上下文很清晰。RenderGraph 管渲染资源依赖，每个 Pass 声明读写哪些资源，Graph 自动分配和同步，加新 Pass 不用改现有代码。

```
App (winit 事件循环)
  └── SystemRegistry
        ├── Update: Camera, Animation
        └── Render: RenderGraph
              ├── ShadowPass
              ├── GBufferPass
              ├── LightingPass
              ├── SkyboxPass
              ├── PostProcessPass
              └── UIPass
```

## 路线图

AetherEngine 的规划分为五个阶段：

| 阶段 | 特性 | 状态 |
|------|------|------|
| **Phase 0** | 骨架（窗口、三角形、egui） | 已完成 |
| **Phase 1** | Deferred PBR + 阴影 + IBL | 计划中 |
| **Phase 2** | SSR + SSAO + 后处理 | 计划中 |
| **Phase 3** | 地形 + 大气 + 水体 + 体积云 | 计划中 |
| **Phase 4** | 光线追踪（Compute + Hybrid） | 计划中 |

这个路线图基本延续了 KongEngine 的方向，但用更现代的架构重新实现。每个阶段都会有个可运行的示例，验证功能没问题。

## 第一个里程碑：引擎骨架

Phase 0 的目标是最小可运行程序。目前完成了：

- wgpu + winit 初始化，创建 1280x720 窗口
- 彩色三角形渲染（验证顶点缓冲、Pipeline、SwapChain 全链路）
- egui 调试面板（实时显示 FPS、帧时间、分辨率）
- 窗口 Resize 支持

运行效果如下：

```bash
cd AetherEngine
cargo run --example 01_triangle
```

窗口中央显示一个红绿蓝渐变的三角形，右下角有 egui 面板显示实时性能数据。整个示例约 300 行，验证了这套技术栈能跑通。

几个设计决策：

1. **egui 在 App 层集成**：Renderer 不依赖 UI 框架，后面想换别的 UI 也方便。
2. **三角形数据硬编码**：不读外部文件，确保示例在任何环境下都能跑。
3. **着色器内联 WGSL**：AI 实现时上下文完整，不用处理文件路径。
4. **示例独立编译**：Cargo 的 examples 机制，每个示例独立编译，不影响主 crate。

## 与 KongEngine 的对比

同样的彩色三角形，在 KongEngine 中需要：
- 编写 GLSL 着色器
- 手动编译着色器到 SPIR-V
- 创建 OpenGL VAO/VBO
- 处理 GL 状态机

而在 AetherEngine 中：
- 内联 WGSL 字符串
- wgpu 自动处理着色器编译
- 使用 `wgpu::util::DeviceExt::create_buffer_init` 一键上传顶点数据
- 无全局状态机，所有状态封装在 Pipeline 中

代码量少了约 40%，而且不用手动管内存。

## 总结与展望

AetherEngine 的立项说白了就是追求开发效率。Rust + wgpu 在编译速度、内存安全和跨平台方面都有明显优势，hecs 的极简设计也让 AI 协作顺畅不少。

接下来重点是 Phase 1：Deferred PBR 管线。G-Buffer、PBR 光照、级联阴影、IBL 这些 KongEngine 里都做过，但在 Rust + wgpu 的架构下实现方式会不一样。

我会继续记录每个阶段的实现过程，就像之前记录 KongEngine 一样。技术之路道阻且长，但好的工具能让这条路走得更快一些。

---

*本文对应 AetherEngine 仓库：https://github.com/ruochenhua/AetherEngine*
