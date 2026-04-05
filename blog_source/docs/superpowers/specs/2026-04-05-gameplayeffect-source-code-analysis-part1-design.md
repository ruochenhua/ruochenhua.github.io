---
name: UE5 GAS GameplayEffect 源码导读（上）设计方案
description: 第3篇 GAS 源码解析文章的详细设计，聚焦 Modifier + GE定义 + Spec + DurationPolicy
type: project
---

## 文章定位

**标题**：UE5 GAS 源码深度解析 | 第3篇：GameplayEffect 源码导读（上）

**定位**：GAS 源码深度解析系列的第3篇，聚焦 GameplayEffect 本身的结构与逻辑，不涉及网络同步与预测。

**目标读者**：
- 已熟悉 GAS 基本使用，读过第1篇（整体架构）和第2篇（AttributeSet）
- 希望从源码层面理解 GE 的设计思想与实现细节
- 不是初学者导向，浅显概念一笔带过，重点机制深入剖析

**系列定位**：
- 第1篇：整体架构与设计思想（已完成）
- 第2篇：AttributeSet 源码剖析（已完成）
- 第3篇：GameplayEffect 源码导读（上）——本文
- 第4篇：GameplayEffect 源码导读（下）——Stacking + Execution + GE组件

**篇幅预期**：不限制长度，充分展开四个核心机制（Modifier、GE定义、Spec、DurationPolicy），预计篇幅会超过第2篇（450行）。

---

## Why：为什么要这样设计

**承接逻辑**：第2篇把 AttributeSet 的数据结构讲完，属性值在内存里怎么存、怎么改、怎么同步已经清楚。但"谁在改、怎么改、改完怎么管"这个问题还没回答——这正是 GameplayEffect 的职责。从 Modifier 开始讲"改数的基本单元"，符合"数据 → 修改 → 流程"的递进逻辑，读者能顺着前两篇的思路继续深入。

**源码细节导向**：用户明确要求"不向初学者做介绍，而是带有针对性的深入解读"，所以设计上要：
- 快速过浅显内容（基础字段、概念定义）
- 深挖关键机制（Magnitude的三种计算方式、聚合器绑定、DurationPolicy分支）
- 用源码片段 + 设计意图分析 + 流程图的方式呈现

**分篇策略**：用户计划用至少两篇文章讲清楚 GE，第一篇聚焦"改数"的核心逻辑（Modifier + GE + Spec + DurationPolicy），第二篇讲高级特性（Stacking + Execution + GE组件）。这样既能保证第一篇的深度充分，又能为第二篇留足空间。

---

## How to apply：如何执行这个设计

### 一、文章结构（Modifier → GE → Spec → DurationPolicy）

#### **第1节：前言**

**承接逻辑**：
- 快速回顾第2篇："上一篇把 AttributeSet 的数据结构讲完，属性值在内存里怎么存、怎么改、怎么同步已经清楚"
- 引出本篇："但'谁在改、怎么改、改完怎么管'这个问题还没回答——这正是 GameplayEffect 的职责"

**GE 在架构里的角色**：
- 快速回顾第1篇的图2（"修改层：怎么改"）
- 强调 GE 是"改属性和改状态的原子操作"

**版本说明**：
- 行文以 **Unreal Engine 5.7** 插件源码为准
- 主要会翻：
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/GameplayEffect.h`
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Private/GameplayEffect.cpp`
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/GameplayEffectSpec.h`
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Private/GameplayEffectSpec.cpp`
  - `AbilitySystemComponent.cpp`（ApplyGameplayEffectSpecToSelf、ExecuteActiveEffects等）

**本篇范围**：
- 静态定义（UGameplayEffect）
- 运行时实例（FGameplayEffectSpec）
- Modifier 机制（改数的基本单元）
- DurationPolicy（Instant / Duration / Infinite 的实现差异）
- **不涉及**：Stacking、ExecutionCalculation、GE组件（Tags、ConditionalEffects等），留给第4篇

---

#### **第2节：从 Modifier 开始：改数的基本单元**

**定位**："在深入 UGameplayEffect 之前，先把改数的基本单元对齐"

**核心内容**：

1. **FGameplayModifierInfo 的基础结构**（一笔带过）
   - 字段：`Attribute`（要改哪个属性）、`ModifierOp`（Add/Multiply/Divide/Override）、`Magnitude`（改多少）
   - Op 类型快速解释语义：
     - Add：加法叠加
     - Multiply：乘法放大
     - Divide：除法缩小
     - Override：直接覆盖（慎用）

2. **Magnitude 的三种计算方式**（深挖）

   **Scalable Float**：
   - `FScalableFloat` 的源码结构：`Value` + `CurveTable` + `CurveRowName`
   - CurveTable 查表：`GetValueAtLevel` 的调用时机
   - Level 缩放：如何根据 Spec 的 Level 动态调整数值
   - 贴 `FScalableFloat::GetValueAtLevel` 的关键代码

   **Attribute Based**：
   - `FAttributeBasedFloat` 的源码结构：`Attribute` + `Coefficient` + `Source/Target`
   - 从另一个属性取值：Capture Source/Target 的语义
   - 贴 `FAttributeBasedFloat::Calculate` 的关键代码
   - 解释 Attribute Capture 的调用时机（在 Spec 创建时捕获，在 Magnitude 计算时使用）

   **Custom Calculation**：
   - `UGameplayEffectMagnitudeCalculation` 的设计意图：自定义计算逻辑
   - `CalculateMagnitude` 的调用时机：在 Spec 创建时调用，得到 EvaluatedMagnitude
   - 贴 `UGameplayEffectMagnitudeCalculation::CalculateMagnitude` 的关键代码
   - 对比 ExecutionCalculation（预告第4篇）

   **对比三种方式的源码路径**：
   - 贴 `FModifierMagnitude::CalculateMagnitude` 的核心分支（switch MagnitudeType）
   - 流程图：三种 Magnitude 计算方式的对比

3. **Modifier 在 Spec 中的激活**（深挖）

   **FModifierSpec 的创建**：
   - 从 GE 的 `ModifierInfo` 到运行时的 `ModifierSpec`
   - 贴 `FGameplayEffectSpec::FModifierSpec` 的构造代码
   - 字段：`EvaluatedMagnitude`（已计算的数值）、`ModifierHandle`（聚合器上的句柄）

   **聚合器绑定**：
   - 贴 `FAggregator::AddModifier` 的关键代码
   - 解释 Modifier 如何挂到聚合器上、返回的 `FModifierHandle` 是什么
   - 流程图：Modifier → Aggregator 的绑定过程

4. **运算调用链**（深挖）

   **FAggregator::ExecuteMod 的核心逻辑**：
   - 贴 `FAggregator::ExecuteMod` 的关键代码（如何从 Base + Modifier 算出 Current）
   - Modifier 的执行顺序：Op 的优先级（Multiply → Add → Override）
   - 堆叠顺序：同一 Op 的多个 Modifier 的执行顺序（按添加时间）

   **流程图**：Modifier → Aggregator → Current Value 的完整路径
   - 从 GE Apply → Spec 创建 → ModifierSpec 激活 → 聚合器绑定 → ExecuteMod → CurrentValue

**实例**：最小化 GE（+10 Attack Buff）
- 构造一个 Duration GE，只有一个 Modifier：Add +10 to Attack
- 对照源码讲解 Modifier 的创建、激活、运算过程
- 不引入项目细节

**流程图**：
- 三种 Magnitude 计算方式的对比（Scalable Float vs Attribute Based vs Custom Calculation）
- Modifier → 聚合器 → Current Value 的调用链

---

#### **第3节：UGameplayEffect：静态配置与蓝图友好**

**定位**："改数的基本单元搞清楚了，现在回头看 UGameplayEffect 如何配置这些 Modifier"

**核心内容**：

1. **UGameplayEffect 的核心字段**（快速过）

   **基础字段**（一笔带过）：
   - `Modifiers`：Modifier 列表
   - `DurationPolicy`：Instant / Duration / Infinite（下一节深挖）
   - `Duration`：持续时间（秒）
   - `Period`：周期执行（用于 DoT 类 GE）

   **高级字段**（一笔带过，预告第4篇）：
   - `StackingType` / `StackLimit` / `StackDurationRefreshPolicy`：堆叠机制（第4篇）
   - `GrantedTags` / `AddedTags` / `RemovedTags`：Tag 管理（第4篇）
   - `ConditionalGameplayEffects`：条件触发（第4篇）
   - `GrantedAbilities`：授予技能（第4篇）

2. **DurationPolicy 的实现差异**（深挖）

   **Instant**：
   - 语义：立即执行一次、不挂聚合器、直接改 Base 或走 Execution
   - 源码路径：`ApplyGameplayEffectSpecToSelf` 中 Instant 的分支（立即 Execute、不创建 ActiveGE）
   - 贴关键代码：`ExecuteActiveEffects` 的调用时机
   - 对比 Duration/Infinite：Instant 不会留在 ASC 的 ActiveEffects 列表里

   **Duration**：
   - 语义：挂聚合器、持续一段时间、定时移除
   - 源码路径：`ApplyGameplayEffectSpecToSelf` 中 Duration 的分支（创建 ActiveGE、计算 EndTime）
   - Duration 字段的计算：`GetDuration()` → `FGameplayEffectSpec::GetDuration()`
   - 定时移除：`UAbilitySystemComponent::CheckActiveGameplayEffects` 的调用时机（每帧检查 EndTime）
   - 贴关键代码：`FActiveGameplayEffect` 的 `StartWorldTime` + `Duration` → `EndWorldTime`

   **Infinite**：
   - 语义：挂聚合器、持续到手动移除、无 Duration
   - 源码路径：`ApplyGameplayEffectSpecToSelf` 中 Infinite 的分支（创建 ActiveGE、Duration = -1）
   - 手动移除：`RemoveActiveGameplayEffect` 的调用路径
   - 贴关键代码：`RemoveActiveGameplayEffect` 的实现

   **对比三种 Policy 的源码分支**：
   - 流程图：DurationPolicy 的分支路径（Instant / Duration / Infinite 的源码走向）

3. **GE 的蓝图可配置性**（一笔带过）
   - Blueprintable 的设计意图：让策划配置 GE、不写 C++
   - Modifier 在蓝图编辑器里的配置界面（不展开，读者应该熟悉）
   - 强调：GE 是"静态配置"，Spec 才是"运行时实例"

**实例**：对比 Instant vs Duration
- 构造两个 GE：
  - GE_Instant：Instant Policy，+10 Attack（立即改 Base）
  - GE_Duration：Duration Policy 10s，+10 Attack（挂聚合器 10s）
- 对照源码讲解两种 Policy 的 Apply → Execute → Remove 路径差异

**流程图**：DurationPolicy 的分支路径
- ApplyGameplayEffectSpecToSelf → switch DurationPolicy → Instant/Duration/Infinite 的不同处理

---

#### **第4节：FGameplayEffectSpec：运行时实例**

**定位**："UGameplayEffect 是静态配置，真正施加到 ASC 上的是 FGameplayEffectSpec"

**核心内容**：

1. **Spec 的创建**（深挖）

   **FGameplayEffectSpec::Create 的关键代码**：
   - 贴 `FGameplayEffectSpec::Create` 的核心逻辑
   - 参数：`GE CDO`、`Instigator`、`Level`、`Context`
   - 创建过程：
     - 从 GE CDO 复制字段到 Spec
     - 实例化 ModifierSpecs（调用 Modifier 的 Magnitude 计算）
     - 初始化 Handle、Duration、StartWorldTime

   **Spec 持有的运行时状态**：
   - `Handle`：`FActiveGameplayEffectHandle`（唯一标识，用于后续管理）
   - `Level`：当前 Level（用于 Magnitude 的 Level 缩放）
   - `Instigator`：施放者（谁施加了这个 GE）
   - `Duration`：实际持续时间（从 GE 的 Duration 字段 + Context 计算）
   - `StartWorldTime`：施加时刻（用于计算剩余时间）

   **ModifierSpecs 的实例化**：
   - 从 GE 的 `Modifiers` 列表创建 `ModifierSpecs`
   - 贴 `FModifierSpec` 的构造代码（调用 Magnitude 计算得到 `EvaluatedMagnitude`）

2. **Spec 的上下文**（深挖）

   **FGameplayEffectContext**：
   - 源码结构：`Instigator`、`SourceObject`、`Ability`、`AbilityLevel`、`SourceTags`、`TargetTags` 等
   - 贴 `FGameplayEffectContext` 的关键字段定义
   - Context 如何在 Spec 创建时传入（`Create` 的参数）
   - Context 如何在 Modifier 运算时使用（Attribute Based Magnitude 的 Capture）

   **Attribute Capture**：
   - `FGameplayEffectAttributeCaptureSpec` 的设计意图：从 Source/Target 的 ASC 捕获属性值
   - 贴 `FGameplayEffectAttributeCaptureSpec::CaptureAttribute` 的关键代码
   - Capture 的时机：Spec 创建时捕获，Magnitude 计算时使用
   - 对比 Snapshot vs Non-Snapshot（预告第4篇）

3. **Spec 与 ActiveGameplayEffect**（一笔带过）

   **FActiveGameplayEffect**：
   - ASC 如何用 ActiveGE 包装 Spec 并管理生命周期
   - 贴 `FActiveGameplayEffect` 的关键字段：`Spec`、`StartWorldTime`、`Duration`、`Handle`
   - Duration GE 的剩余时间计算：`GetRemainingTime()` → `EndWorldTime - CurrentWorldTime`
   - 定时移除：`CheckActiveGameplayEffects` 的调用（每帧检查 EndTime）

   **不展开**：ActiveGE 的详细管理逻辑（Stacking、网络同步）留给第4篇

**实例**：追踪 Duration GE 的完整路径
- 从 Apply → Spec 创建 → ActiveGE 包装 → ASC 管理 → Remove
- 对照源码讲解每个步骤的关键代码

**流程图**：GE CDO → Spec 创建 → ActiveGE 包装 → ASC 管理的流程
- ApplyGameplayEffectSpecToSelf → Create Spec → Wrap in ActiveGE → Add to ActiveEffects → CheckDuration → Remove

---

#### **第5节：小结**

**总结四个核心机制的要点**：

- **Modifier**：改数的基本单元
  - Magnitude 的三种计算方式：Scalable Float（CurveTable）、Attribute Based（Capture）、Custom Calculation（自定义）
  - 聚合器绑定：Modifier 如何挂到聚合器上、返回 Handle
  - 运算调用链：Aggregator::ExecuteMod → Base + Modifier → Current

- **GE 定义**：静态配置
  - 核心字段：Modifiers、DurationPolicy、Duration、Period
  - Blueprintable 的设计意图：让策划配置、不写 C++

- **Spec**：运行时实例
  - 创建：从 GE CDO → Spec，实例化 ModifierSpecs
  - 上下文：FGameplayEffectContext、Attribute Capture
  - 状态：Handle、Level、Duration、StartWorldTime

- **DurationPolicy**：Instant / Duration / Infinite 的实现差异
  - Instant：立即执行、不挂聚合器
  - Duration：挂聚合器、定时移除
  - Infinite：挂聚合器、手动移除

**阅读建议**：
- 建议读者在源码中追踪的路径：
  - `ApplyGameplayEffectSpecToSelf` → `Create Spec` → `ExecuteActiveEffects` → `Aggregator::ExecuteMod`
- 建议对照最小化 GE 实例调试（+10 Attack Buff）
- 建议对比 Instant vs Duration 的 Apply 路径

---

#### **第6节：收尾与预告**

**收尾**：
- "好了，以上就是 GameplayEffect 源码导读的第一部分，从 Modifier 的改数机制到 GE 的静态配置、运行时实例、DurationPolicy 的实现差异"

**预告第4篇**：
- **Stacking 机制**：堆叠计数、刷新策略、堆叠上限、堆叠对 Modifier 运算的影响
- **ExecutionCalculation**：自定义执行逻辑、Exec 与 Modifier 的协作、Exec 的调用时机
- **GE 组件**：Tags（Granted/Added/Removed）、ConditionalGameplayEffects、GrantedAbilities、免疫与免疫Tag

---

### 二、写作风格（参考前两篇文章）

#### **图文风格**

**Mermaid 流程图/架构图**：
- 用 `{% mermaid %}` 标签包裹，紧跟简洁的图注（如 "*图 1：xxx*")
- 流程图用 `flowchart TB/LR`、`sequenceDiagram`
- 节点命名简洁（中文+英文缩写），用 `subgraph` 组织层次

**普通图片**：
- 用 `![](图片名.png)` 插入，紧跟图注
- 图片命名简洁，图注解释核心含义

**代码块**：
- 用 ` ```cpp ``` ` 包裹
- 开头注释标注源码路径（如 `// GameplayEffect.cpp，DurationPolicy 的分支`）
- 代码片段精简，只贴关键函数
- 重要行用中文注释标注（如 `// 立即执行、不创建 ActiveGE`）

#### **语法风格**

**中文表述习惯**：
- 技术术语用中文+英文缩写（如"属性"、"聚合器"、"效果"）
- 句式偏口语化但严谨（如"你可能会奇怪"、"我总结了下面几个好处"、"好了，以上就是"）
- 强调读者视角（如"你以后看 GAS 源码的时候"、"读 Lyra 可以按同一套思路对照")

**术语翻译策略**：
- 保留核心英文术语（GE、Modifier、Spec、Aggregator、DurationPolicy）
- 用中文解释语义（如"DurationPolicy：持续时间策略，决定 GE 是立即执行还是持续挂载"）
- 不过度翻译（如"ExecutionCalculation"不翻译）

**代码注释风格**：
- 中文注释为主，简洁直白（如 `// 立即执行`、`// 挂聚合器`）
- 注释解释意图，不逐行解释语法

#### **章节组织风格**

**固定结构**：
- **前言**：承接上文、定位本篇、版本说明、源码路径
- **正文**：分节讲解，每节有标题、小节标题、代码、流程图
- **小结**：总结本篇要点
- **收尾**：预告下一篇

**分节风格**：
- 每节开头有简短定位（如"在深入 UGameplayEffect 之前，先把改数的基本单元对齐"）
- 小节标题简洁（如"FGameplayModifierInfo 的基础结构"、"Magnitude 的三种计算方式"）
- 重要机制单独开一节（如"Modifier 在 Spec 中的激活"、"DurationPolicy 的实现差异"）

#### **深度控制风格**

**浅显内容一笔带过**：
- 快速过基础字段（如"概念本身不玄"、"就是一个普通的 UObject")
- 不解释 UE 基础概念（如"UPROPERTY"、"CDO"、"Blueprintable"默认读者已懂）

**重点机制深入剖析**：
- 贴源码片段 + 设计意图分析（如"为啥 Magnitude 要分成三种方式？大致有三个理由"）
- 对比不同路径的实现差异（如"Instant vs Duration vs Infinite"、"三种 Magnitude 的源码路径"）
- 流程图 + 调用链剖析（如"Modifier → Aggregator → Current Value 的完整路径"）

---

### 三、流程图与实例设计

#### **流程图清单**

1. **三种 Magnitude 计算方式的对比**
   - Scalable Float → CurveTable 查表
   - Attribute Based → Capture Source/Target 属性
   - Custom Calculation → UGameplayEffectMagnitudeCalculation::CalculateMagnitude

2. **Modifier → 聚合器 → Current Value 的调用链**
   - GE Apply → Spec 创建 → ModifierSpec 激活 → Aggregator::AddModifier → Aggregator::ExecuteMod → CurrentValue

3. **DurationPolicy 的分支路径**
   - ApplyGameplayEffectSpecToSelf → switch DurationPolicy → Instant/Duration/Infinite 的不同处理

4. **GE CDO → Spec 创建 → ActiveGE 包装 → ASC 管理**
   - ApplyGameplayEffectSpecToSelf → Create Spec → Wrap in ActiveGE → Add to ActiveEffects → CheckDuration → Remove

#### **实例清单**

1. **最小化 GE（+10 Attack Buff）**
   - Duration Policy，只有一个 Modifier：Add +10 to Attack
   - 对照源码讲解 Modifier 的创建、激活、运算

2. **对比 Instant vs Duration**
   - GE_Instant：Instant Policy，+10 Attack（立即改 Base）
   - GE_Duration：Duration Policy 10s，+10 Attack（挂聚合器 10s）
   - 对照源码讲解两种 Policy 的 Apply 路径差异

3. **追踪 Duration GE 的完整路径**
   - Apply → Spec 创建 → ActiveGE 包装 → ASC 管理 → Remove

---

### 四、小结与预告设计

**小结结构**：
- 用列表形式总结四个核心机制的要点（Modifier、GE定义、Spec、DurationPolicy）
- 每个要点用 2-3 行概括关键内容

**阅读建议**：
- 建议读者在源码中追踪的路径（具体的函数名）
- 建议对照最小化 GE 实例调试
- 建议对比不同 Policy 的 Apply 路径

**预告第4篇**：
- Stacking 机制
- ExecutionCalculation
- GE 组件（Tags、ConditionalEffects、GrantedAbilities）

---

## 质量检查清单（自查）

在撰写文章前，需要确认：

1. **承接逻辑是否清晰**：从第2篇的 AttributeSet → 第3篇的 GameplayEffect，承接语句是否自然
2. **深度控制是否合理**：浅显内容一笔带过、重点机制深入剖析，是否符合用户预期
3. **流程图是否必要**：每张流程图是否真的能帮助读者理解源码路径，避免冗余
4. **实例是否简洁**：最小化 GE 不引入项目细节，是否足够解释源码逻辑
5. **术语翻译是否一致**：与前两篇的术语翻译策略保持一致（中文+英文缩写）
6. **代码注释风格是否统一**：中文注释、简洁直白、解释意图
7. **篇幅预期是否合理**：四个机制充分展开，篇幅预计超过第2篇，是否符合用户预期

---

## 写作顺序建议

1. **先写前言**：承接逻辑、版本说明、范围定义
2. **先构造实例**：最小化 GE、对比 GE，用于后续对照讲解
3. **按顺序写正文**：第2节 → 第3节 → 第4节，每节完成后自查深度控制
4. **写小结**：总结要点、阅读建议
5. **写收尾与预告**：预告第4篇的内容
6. **自查质量**：承接逻辑、深度控制、流程图必要性、实例简洁性、术语一致性、代码注释风格、篇幅预期

---

## 关键源码路径（写作时参考）

**GameplayEffect.h/cpp**：
- `UGameplayEffect` 的字段定义
- `DurationPolicy` 的枚举定义

**GameplayEffectSpec.h/cpp**：
- `FGameplayEffectSpec::Create`
- `FModifierSpec` 的构造
- `FGameplayEffectSpec::GetDuration`

**AbilitySystemComponent.cpp**：
- `ApplyGameplayEffectSpecToSelf`（DurationPolicy 的分支）
- `ExecuteActiveEffects`（Instant 的执行）
- `CheckActiveGameplayEffects`（Duration 的定时移除）
- `RemoveActiveGameplayEffect`（Infinite 的手动移除）

**GameplayEffectModifierMagnitude.h/cpp**：
- `FModifierMagnitude::CalculateMagnitude`（三种 Magnitude 的分支）

**AttributeSet.cpp**（参考）：
- `FAggregator::AddModifier`（聚合器绑定）
- `FAggregator::ExecuteMod`（运算调用链）

**GameplayEffectAttributeCaptureSpec.h/cpp**：
- `FGameplayEffectAttributeCaptureSpec::CaptureAttribute`（Attribute Capture）