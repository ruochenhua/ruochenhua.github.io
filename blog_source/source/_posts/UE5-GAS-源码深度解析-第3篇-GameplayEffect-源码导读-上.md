---
title: UE5 GAS 源码深度解析 | 第3篇：GameplayEffect 源码导读（上）
date: 2026-04-05 10:00:00
categories:
  - 技术漫谈
  - 游戏开发
tags: [UE5, GAS, 源码解析, 游戏开发, GameplayEffect]
cover: 2026/04/05/UE5-GAS-源码深度解析-第3篇-GameplayEffect-源码导读-上/gas-part3-cover.png
cover_type: img
top_img: 2026/04/05/UE5-GAS-源码深度解析-第3篇-GameplayEffect-源码导读-上/gas-part3-banner.png
---

## 前言

[第 2 篇](/2026/03/21/UE5-GAS-源码深度解析-第2篇-AttributeSet-源码剖析/)把 AttributeSet 的数据结构讲完，属性值在内存里怎么存、怎么改、怎么同步已经清楚。但"谁在改、怎么改、改完怎么管"这个问题还没回答——这正是 GameplayEffect（GE）的职责。

上一篇文末预告的是 ASC，但效果这东西改属性、挂 Buff、管持续时间，几乎把 GAS 里"改数"这条线的核心逻辑都串起来了。理解了 GE 的源码，后面再读 ASC 的管理、网络预测、Stacking 会省不少力气，所以这篇先把 GameplayEffect 交代清楚。

### GE 在架构里的角色

回顾 [第 1 篇的图 2](/2026/03/10/UE5-GAS-源码深度解析-第1篇-整体架构与设计思想/)，GE 处在"修改层"：负责"改属性和改状态"的原子操作。一个 GE 可以配置若干 Modifier（改哪个属性、怎么改、改多少），也可以改 GameplayTag（加/减状态标签），还可以授予技能、触发条件效果等。

这篇聚焦 GE 改属性的核心逻辑——Modifier 机制、GE 的静态定义、运行时实例（Spec）、DurationPolicy（Instant/Duration/Infinite）。Stacking、ExecutionCalculation、GE 组件（Tags、ConditionalEffects、GrantedAbilities）这些高级特性留给第 4 篇。

### 版本说明

- 文本文依旧是以 **Unreal Engine 5.7** 插件源码为准，和你本地不一致的地方以你手里的代码为准。
- 主要会翻：
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/GameplayEffect.h`
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Private/GameplayEffect.cpp`
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/GameplayEffectSpec.h`
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Private/GameplayEffectSpec.cpp`
  - `AbilitySystemComponent.h` / `AbilitySystemComponent.cpp`（ApplyGameplayEffectSpecToSelf、ExecuteActiveEffects 等）
  - `GameplayEffectModifierMagnitude.h` / `GameplayEffectModifierMagnitude.cpp`（三种 Magnitude 的分支）
  - `AttributeSet.cpp`（FAggregator::AddModifier、FAggregator::ExecuteMod）
  - `GameplayEffectAttributeCaptureSpec.h` / `GameplayEffectAttributeCaptureSpec.cpp`（Attribute Capture）

类名、函数名建议在上述文件里搜一下，边看边对。

---

## 从 Modifier 开始：改数的基本单元

在深入 `UGameplayEffect` 之前，先把改数的基本单元对齐——Modifier。一个 GE 可以有多个 Modifier，每个 Modifier 负责"改一个属性"。

### FGameplayModifierInfo：配置时的结构

`FGameplayModifierInfo` 是 GE 里配置 Modifier 的结构，核心字段：

- `Attribute`：要改哪个属性（`FGameplayAttribute` 句柄）
- `ModifierOp`：怎么改（`EGameplayModOp::Type` 枚举）
- `ModifierMagnitude`：改多少（`FGameplayEffectModifierMagnitude`）

`ModifierOp` 的运算语义和执行顺序，源码里的注释写得很清楚：

```cpp
// GameplayEffectTypes.h
/**
 * Defines the ways that mods will modify attributes. Values of the same type are aggregated,
 * and then applied in the following equation:
 * ((BaseValue + AddBase) * MultiplyAdditive / DivideAdditive * MultiplyCompound) + AddFinal
 */
namespace EGameplayModOp
{
    enum Type : int
    {
        AddBase,             // 先加到 Base 上
        MultiplyAdditive,    // 乘数叠加（先加后乘）
        DivideAdditive,      // 除数叠加（先加后除）
        MultiplyCompound,    // 乘数复合（连续乘）
        AddFinal,            // 最后加
        Override,            // 直接覆盖
        Max
    };
}
```

**六种运算的执行顺序**：

1. **AddBase**：先执行，加到 BaseValue 上
2. **MultiplyAdditive**：乘数先加在一起，再乘
3. **DivideAdditive**：除数先加在一起，再除
4. **MultiplyCompound**：连续相乘
5. **AddFinal**：最后加
6. **Override**：直接覆盖（慎用）

**完整公式**：`((BaseValue + AddBase) * MultiplyAdditive / DivideAdditive * MultiplyCompound) + AddFinal`

举个例子：BaseValue = 100，有 3 个 Modifier（AddBase +10、MultiplyAdditive 0.5、AddFinal +20）

- 先算 AddBase：`100 + 10 = 110`
- 再算 MultiplyAdditive：如果有两个乘数 0.5 和 0.3，先加起来 `0.5 + 0.3 = 0.8`，再乘 `110 * 0.8 = 88`
- 最后算 AddFinal：`88 + 20 = 108`

概念本身不玄，重点在 `ModifierMagnitude` 怎么算——这是 Modifier 的核心。

### ModifierMagnitude 的四种计算方式

`FGameplayEffectModifierMagnitude` 支持四种计算方式，源码里用 `EGameplayEffectMagnitudeCalculation` 枚举区分：

```cpp
// GameplayEffect.h
enum class EGameplayEffectMagnitudeCalculation : uint8
{
    ScalableFloat,           // 可缩放的数值（CurveTable 查表）
    AttributeBased,          // 基于另一个属性
    CustomCalculationClass,  // 自定义计算
    SetByCaller              // 由调用者设置
};
```

#### Scalable Float：CurveTable 查表 + Level 缩放

最常用的一种。`FScalableFloat` 可以直接指定数值，也可以从 CurveTable 查表：

```cpp
// Engine/Source/Runtime/GameplayTags/Classes/GameplayTagContainer.h
USTRUCT()
struct FScalableFloat
{
    GENERATED_USTRUCT_BODY()

    UPROPERTY(EditDefaultsOnly, Category = ScalableFloat)
    float Value = 0.f;

    UPROPERTY(EditDefaultsOnly, Category = ScalableFloat)
    FCurveTableRowHandle CurveRow;
};
```

**设计意图**：让策划配一张表，不同 Level 对应不同数值。比如"技能等级 1 → +10 攻击力，等级 2 → +20 攻击力"，GE 施加时传入 Level，自动查表得到数值。

**调用时机**：Spec 创建时调用 `AttemptCalculateMagnitude`，得到 `EvaluatedMagnitude`（已计算的数值），后续运算直接用这个值。

#### Attribute Based：从另一个属性取值

从 Source 或 Target 的 ASC 上捕获另一个属性的值，支持多种计算策略。`FAttributeBasedFloat` 的源码：

```cpp
// GameplayEffect.h
USTRUCT()
struct FAttributeBasedFloat
{
    GENERATED_USTRUCT_BODY()

    // 计算公式：(Coefficient * (PreMultiplyAdditiveValue + [属性值])) + PostMultiplyAdditiveValue
    UPROPERTY(EditDefaultsOnly, Category=AttributeFloat)
    FScalableFloat Coefficient;

    UPROPERTY(EditDefaultsOnly, Category=AttributeFloat)
    FScalableFloat PreMultiplyAdditiveValue;

    UPROPERTY(EditDefaultsOnly, Category=AttributeFloat)
    FScalableFloat PostMultiplyAdditiveValue;

    // 要捕获的属性
    UPROPERTY(EditDefaultsOnly, Category=AttributeFloat)
    FGameplayEffectAttributeCaptureDefinition BackingAttribute;

    // 计算策略：最终值 / Base值 / Bonus值
    UPROPERTY(EditDefaultsOnly, Category=AttributeFloat)
    EAttributeBasedFloatCalculationType AttributeCalculationType;
};
```

**EAttributeBasedFloatCalculationType** 四种策略：

- `AttributeMagnitude`：用最终计算值（Current）
- `AttributeBaseValue`：用 Base 值
- `AttributeBonusMagnitude`：用 Bonus 值（Current - Base）
- `AttributeMagnitudeEvaluatedUpToChannel`：算到指定 Channel 为止

**设计意图**：让 Modifier 的数值动态依赖另一个属性。比如"Buff 强度 = 目标当前生命值 × 0.1"，目标血量变化时，Buff 强度跟着变。

**Capture 的时机**：Spec 创建时捕获（Snapshot）或运算时实时取值（Non-Snapshot），由 `BackingAttribute` 的 `Snapshot` 字段决定。

#### Custom Calculation：自定义计算逻辑

最灵活的一种，继承 `UGameplayModMagnitudeCalculation`，在蓝图或 C++ 里写自定义逻辑：

```cpp
// GameplayModMagnitudeCalculation.h
UCLASS(Abstract, Blueprintable)
class UGameplayModMagnitudeCalculation : public UGameplayEffectCalculation
{
    GENERATED_UCLASS_BODY()

    // 计算基础数值
    UFUNCTION(BlueprintNativeEvent, Category="Calculation")
    float CalculateBaseMagnitude(const FGameplayEffectSpec& Spec) const;
};
```

**设计意图**：当 Scalable Float 和 Attribute Based 都不够用时，用自定义计算。比如"根据目标身上已有的 Buff 数量决定强度"、"根据距离衰减"等复杂逻辑。

**调用时机**：Spec 创建时调用 `CalculateBaseMagnitude`，算出的值还会被 `FCustomCalculationBasedFloat` 的 Coefficient、PreMultiplyAdditiveValue、PostMultiplyAdditiveValue 进一步处理。

#### SetByCaller：由调用者设置

运行时由代码或蓝图设置数值，不在 GE 里配置：

```cpp
// GameplayEffect.h
USTRUCT()
struct FSetByCallerFloat
{
    GENERATED_USTRUCT_BODY()

    UPROPERTY(VisibleDefaultsOnly, Category=SetByCaller)
    FName DataName;  // 用名字标识

    UPROPERTY(EditDefaultsOnly, Category = SetByCaller, meta = (Categories = "SetByCaller"))
    FGameplayTag DataTag;  // 或用 Tag 标识
};
```

**设计意图**：让运行时决定数值。比如"技能伤害 = 武器伤害 × 技能倍率"，武器伤害在运行时从武器 Actor 上取，不在 GE 里写死。

**使用方式**：在创建 Spec 时调用 `SetSetByCallerMagnitude` 设置数值，Spec 创建后 Magnitude 计算时会直接用这个值。

#### 对比四种方式的源码路径

`FGameplayEffectModifierMagnitude::AttemptCalculateMagnitude` 的核心分支：

```cpp
// GameplayEffect.cpp
bool FGameplayEffectModifierMagnitude::AttemptCalculateMagnitude(
    const FGameplayEffectSpec& InRelevantSpec,
    OUT float& OutCalculatedMagnitude) const
{
    switch (MagnitudeCalculationType)
    {
    case EGameplayEffectMagnitudeCalculation::ScalableFloat:
        // 从 ScalableFloat 或 CurveTable 取值
        OutCalculatedMagnitude = ScalableFloatMagnitude.GetValue();
        break;

    case EGameplayEffectMagnitudeCalculation::AttributeBased:
        // 从捕获的属性计算
        OutCalculatedMagnitude = AttributeBasedMagnitude.CalculateMagnitude(InRelevantSpec);
        break;

    case EGameplayEffectMagnitudeCalculation::CustomCalculationClass:
        // 调用自定义计算类
        OutCalculatedMagnitude = CustomMagnitude.CalculateMagnitude(InRelevantSpec);
        break;

    case EGameplayEffectMagnitudeCalculation::SetByCaller:
        // 从 Spec 的 SetByCaller 数值里取
        OutCalculatedMagnitude = InRelevantSpec.GetSetByCallerMagnitude(SetByCallerMagnitude);
        break;
    }
    return true;
}
```

{% mermaid %}
flowchart TB
    Spec["FGameplayEffectSpec"] --> Magnitude["AttemptCalculateMagnitude"]

    Magnitude --> Type{MagnitudeCalculationType}

    Type -->|ScalableFloat| Curve["ScalableFloat\n或 CurveTable 查表"]
    Type -->|AttributeBased| Capture["捕获属性值\n× Coefficient"]
    Type -->|CustomCalculationClass| Custom["自定义计算类\nCalculateBaseMagnitude"]
    Type -->|SetByCaller| SetByCaller["从 Spec 取\nSetByCaller 数值"]

    Curve --> Eval["EvaluatedMagnitude\n（已计算的数值）"]
    Capture --> Eval
    Custom --> Eval
    SetByCaller --> Eval
{% endmermaid %}

*图 1：四种 Magnitude 计算方式都在 Spec 创建时调用，得到 EvaluatedMagnitude。*

### Modifier 在 Spec 中的激活

GE 是静态配置，真正施加到 ASC 上的是 `FGameplayEffectSpec`（运行时实例）。Spec 创建时会把 GE 的每个 `FGameplayModifierInfo` 对应起来，但运行时的数据结构比配置时简单。

#### FModifierSpec：运行时的 Modifier

```cpp
// GameplayEffect.h
USTRUCT()
struct FModifierSpec
{
    GENERATED_USTRUCT_BODY()

    FModifierSpec() : EvaluatedMagnitude(0.f) { }

    float GetEvaluatedMagnitude() const { return EvaluatedMagnitude; }

private:
    // 已计算的数值
    UPROPERTY()
    float EvaluatedMagnitude;

    // 只有 Spec 和 ActiveEffectsContainer 能设置这个值
    friend struct FGameplayEffectSpec;
    friend struct FActiveGameplayEffectsContainer;
};
```

**关键**：`FModifierSpec` 只存 `EvaluatedMagnitude`，不存 `ModifierInfo` 或 `ModifierHandle`。`ModifierInfo` 在 Spec 的 `Modifiers` 数组里，`ModifierHandle` 在 `FActiveGameplayEffect` 的 `ModifierHandles` 数组里。

**Spec 如何持有 Modifier 信息**：

```cpp
// GameplayEffect.h (简化)
struct FGameplayEffectSpec
{
    const UGameplayEffect* Def;  // GE CDO
    TArray<FModifierSpec> Modifiers;  // 运行时的 ModifierSpecs（只有 EvaluatedMagnitude）

    // 从 GE 的 ModifierInfo 创建 ModifierSpec
    void InitializeModifierSpecs(const UGameplayEffect* InGE);
};
```

**创建过程**：Spec 构造时遍历 `Def->Modifiers`，对每个 `FGameplayModifierInfo` 调用 `ModifierMagnitude.AttemptCalculateMagnitude`，算出 `EvaluatedMagnitude`，存入 `Modifiers` 数组。

#### 聚合器绑定：Modifier 如何挂到 ASC 上

Duration / Infinite 的 GE 会把 Modifier 挂到聚合器（Aggregator）上。聚合器是每个属性上的"运算中枢"，维护所有生效的 Modifier，求值时把 Base 和各条 Modifier 按规则合成 Current。

绑定发生在 `FActiveGameplayEffectsContainer::AddModifierToAggregator`：

```cpp
// AbilitySystemComponent.cpp (简化)
void FActiveGameplayEffectsContainer::AddModifierToAggregator(
    FActiveGameplayEffect& ActiveGE,
    int32 ModifierIndex)
{
    const FGameplayModifierInfo& ModInfo = ActiveGE.Spec.Def->Modifiers[ModifierIndex];
    const FModifierSpec& ModSpec = ActiveGE.Spec.Modifiers[ModifierIndex];

    // 拿到属性的聚合器
    FAggregator* Agg = Owner->GetAggregator(ModInfo.Attribute);

    // 添加 Modifier 到聚合器
    FAggregatorMod Mod;
    Mod.Op = ModInfo.ModifierOp;
    Mod.EvaluatedMagnitude = ModSpec.GetEvaluatedMagnitude();
    Mod.SourceActiveGE = &ActiveGE;

    int32 ModIdx = Agg->Modifiers.Add(Mod);

    // 把 ModIdx 存到 ActiveGE.ModifierHandles 里
    ActiveGE.ModifierHandles.Add(ModIdx);
}
```

**ModifierHandles 的作用**：`FActiveGameplayEffect` 维护一个 `TArray<int32> ModifierHandles`，存每个 Modifier 在聚合器里的索引。移除 GE 时，用这些索引从聚合器移除对应 Modifier。

{% mermaid %}
flowchart LR
    GE["UGameplayEffect\n（静态配置）"] -->|创建| Spec["FGameplayEffectSpec"]
    Spec -->|实例化| ModSpecs["TArray<FModifierSpec>\n（只有 EvaluatedMagnitude）"]
    ModSpecs -->|AddModifierToAggregator| Aggregator["FAggregator\n（聚合器）"]
    Aggregator -->|返回索引| Handles["FActiveGameplayEffect\n.ModifierHandles"]
{% endmermaid %}

*图 2：从 GE 到 Spec 到 ModifierSpec，再挂到聚合器上，索引存到 ActiveGE.ModifierHandles。*

### 运算调用链：从 Modifier 到 Current Value

Modifier 挂到聚合器后，每次属性求值都会调用聚合器的运算逻辑，把 Base 和所有 Modifier 合成 Current。

#### Modifier 的执行顺序

聚合器求值时，按 `EGameplayModOp` 的顺序执行，不是按添加顺序。源码里用 `FAggregatorModChannel::ExecuteMod` 实现：

```cpp
// GameplayEffectAggregator.cpp (简化)
float FAggregatorModChannel::ExecuteMod(
    const float InBaseValue,
    const TArray<FAggregatorMod>& Mods) const
{
    float Result = InBaseValue;

    // 1. AddBase
    float AddBaseSum = 0.f;
    for (const FAggregatorMod& Mod : Mods)
    {
        if (Mod.Op == EGameplayModOp::AddBase)
        {
            AddBaseSum += Mod.EvaluatedMagnitude;
        }
    }
    Result += AddBaseSum;

    // 2. MultiplyAdditive
    float MultiplyAdditiveSum = 0.f;
    for (const FAggregatorMod& Mod : Mods)
    {
        if (Mod.Op == EGameplayModOp::MultiplyAdditive)
        {
            MultiplyAdditiveSum += Mod.EvaluatedMagnitude;
        }
    }
    Result *= MultiplyAdditiveSum;

    // 3. DivideAdditive
    float DivideAdditiveSum = 0.f;
    for (const FAggregatorMod& Mod : Mods)
    {
        if (Mod.Op == EGameplayModOp::DivideAdditive)
        {
            DivideAdditiveSum += Mod.EvaluatedMagnitude;
        }
    }
    if (DivideAdditiveSum != 0.f)
    {
        Result /= DivideAdditiveSum;
    }

    // 4. MultiplyCompound
    for (const FAggregatorMod& Mod : Mods)
    {
        if (Mod.Op == EGameplayModOp::MultiplyCompound)
        {
            Result *= Mod.EvaluatedMagnitude;
        }
    }

    // 5. AddFinal
    float AddFinalSum = 0.f;
    for (const FAggregatorMod& Mod : Mods)
    {
        if (Mod.Op == EGameplayModOp::AddFinal)
        {
            AddFinalSum += Mod.EvaluatedMagnitude;
        }
    }
    Result += AddFinalSum;

    // 6. Override（只取最后一个）
    for (const FAggregatorMod& Mod : Mods)
    {
        if (Mod.Op == EGameplayModOp::Override)
        {
            Result = Mod.EvaluatedMagnitude;
        }
    }

    return Result;
}
```

**执行顺序**：
1. 所有 AddBase 先加在一起
2. 所有 MultiplyAdditive 先加在一起，再乘
3. 所有 DivideAdditive 先加在一起，再除
4. 所有 MultiplyCompound 连续相乘
5. 所有 AddFinal 先加在一起
6. Override 取最后一个

**为什么这样设计**：AddBase/MultiplyAdditive/DivideAdditive/AddFinal 同类 Op 先聚合再运算，可以保证运算顺序一致；MultiplyCompound 和 Override 是逐个执行，结果依赖顺序。

{% mermaid %}
flowchart TB
    Base["BaseValue"] --> AddBase["+ 所有 AddBase\n先加在一起"]
    AddBase --> Multiply["× 所有 MultiplyAdditive\n先加在一起再乘"]
    Multiply --> Divide["÷ 所有 DivideAdditive\n先加在一起再除"]
    Divide --> Compound["× 所有 MultiplyCompound\n连续相乘"]
    Compound --> AddFinal["+ 所有 AddFinal\n先加在一起"]
    AddFinal --> Override["Override\n取最后一个"]
    Override --> Current["CurrentValue"]

    subgraph Mods["聚合器上的 Modifier 列表"]
        M1["Modifier 1 (AddBase)"]
        M2["Modifier 2 (MultiplyAdditive)"]
        M3["Modifier 3 (DivideAdditive)"]
        M4["Modifier 4 (MultiplyCompound)"]
        M5["Modifier 5 (AddFinal)"]
        M6["Modifier 6 (Override)"]
    end
{% endmermaid %}

*图 3：ExecuteMod 按 Op 类型分组执行，同类 Op 先聚合再运算。*

#### 完整调用链

从 GE Apply 到 Current Value 的完整路径：

{% mermaid %}
sequenceDiagram
    participant ASC as AbilitySystemComponent
    participant Spec as FGameplayEffectSpec
    participant ActiveGE as FActiveGameplayEffect
    participant Agg as FAggregator
    participant Attr as AttributeSet

    ASC->>Spec: 创建 Spec
    Spec->>Spec: AttemptCalculateMagnitude<br/>（算出 EvaluatedMagnitude）
    ASC->>ActiveGE: 创建 ActiveGE
    ActiveGE->>Agg: AddModifierToAggregator
    Agg->>Agg: 挂到 Modifiers 列表

    Note over ASC: 属性求值时
    ASC->>Agg: ExecuteMod
    Agg->>Attr: 读 BaseValue
    Agg->>Agg: 按 Op 顺序运算
    Agg->>Attr: 写 CurrentValue
{% endmermaid %}

*图 4：从 GE Apply 到 Current Value 的完整调用链。*

### 最小化实例：+10 Attack Buff

构造一个最简单的 Duration GE，只有一个 Modifier：

```cpp
// GE_AttackBuff
DurationPolicy = EGameplayEffectDurationType::HasDuration;
DurationMagnitude = 10.f;  // 持续 10 秒

Modifiers[0].Attribute = AttackAttribute;
Modifiers[0].ModifierOp = EGameplayModOp::AddBase;
Modifiers[0].ModifierMagnitude = ScalableFloat(10.f);
```

**执行流程**：
1. `ApplyGameplayEffectSpecToSelf`：创建 Spec
2. `AttemptCalculateMagnitude`：`EvaluatedMagnitude = 10.f`
3. `AddModifierToAggregator`：挂到 Attack 属性的聚合器上
4. `ExecuteMod`：`Result = BaseValue + 10`
5. 10 秒后 `RemoveActiveGameplayEffect`：从聚合器移除 Modifier，Current 恢复到 Base

这个实例覆盖了 Modifier 的核心路径：创建 → 激活 → 运算 → 移除。后面讲 DurationType 时会对比 Instant vs HasDuration 的差异。

---

```cpp
// GameplayEffectModifierMagnitude.cpp
float FAttributeBasedFloat::Calculate(const FGameplayEffectSpec& Spec) const
{
    float CapturedValue = 0.f;
    // 从 Spec 的 CaptureSpec 里拿捕获的属性值
    if (AttributeToCapture.IsValid())
    {
        CapturedValue = AttributeToCapture.GetCapturedAttributeMagnitude();
    }
    return CapturedValue * Coefficient;
}
```

**设计意图**：让 Modifier 的数值动态依赖另一个属性。比如"Buff 强度 = 目标当前生命值 * 0.1"，目标血量变化时，Buff 强度跟着变。

**Capture 的时机**：Spec 创建时捕获（Snapshot）或运算时实时取值（Non-Snapshot），由 GE 配置决定。Snapshot vs Non-Snapshot 的差异在第 4 篇讲网络预测时会展开。

#### Custom Calculation：自定义计算逻辑

最灵活的一种，继承 `UGameplayEffectMagnitudeCalculation`，在蓝图或 C++ 里写自定义逻辑：

```cpp
// GameplayEffectModifierMagnitude.h
UCLASS(Abstract, Blueprintable)
class UGameplayEffectMagnitudeCalculation : public UObject
{
    GENERATED_UCLASS_BODY()

    UFUNCTION(BlueprintNativeEvent, Category = "Calculation")
    float CalculateMagnitude(const FGameplayEffectSpec& Spec) const;
    virtual float CalculateMagnitude_Implementation(const FGameplayEffectSpec& Spec) const;
};
```

**设计意图**：当 Scalable Float 和 Attribute Based 都不够用时，用自定义计算。比如"根据目标身上已有的 Buff 数量决定强度"、"根据距离衰减"等复杂逻辑。

**调用时机**：Spec 创建时调用 `CalculateMagnitude`，得到 `EvaluatedMagnitude`。

#### 对比三种方式的源码路径

`FModifierMagnitude::CalculateMagnitude` 的核心分支：

```cpp
// GameplayEffectModifierMagnitude.cpp
float FModifierMagnitude::CalculateMagnitude(const FGameplayEffectSpec& Spec) const
{
    switch (MagnitudeType)
    {
    case EModifierMagnitudeType::Scalable:
        return ScalableFloatMagnitude.GetValueAtLevel(Spec.GetLevel());
    case EModifierMagnitudeType::AttributeBased:
        return AttributeBasedMagnitude.Calculate(Spec);
    case EModifierMagnitudeType::Custom:
        return CustomMagnitude->CalculateMagnitude(Spec);
    default:
        return 0.f;
    }
}
```

{% mermaid %}
flowchart TB
    subgraph Spec["Spec 创建时"]
        Level["Spec.Level"] --> Magnitude["FModifierMagnitude::CalculateMagnitude"]
    end

    Magnitude --> Type{MagnitudeType}

    Type -->|Scalable| Curve["CurveTable 查表\nGetValueAtLevel(Level)"]
    Type -->|AttributeBased| Capture["从 CaptureSpec 取属性值\n× Coefficient"]
    Type -->|Custom| Custom["CustomCalculation\n::CalculateMagnitude(Spec)"]

    Curve --> Eval["EvaluatedMagnitude\n（已计算的数值）"]
    Capture --> Eval
    Custom --> Eval
{% endmermaid %}

*图 1：三种 Magnitude 计算方式都在 Spec 创建时调用，得到 EvaluatedMagnitude 后不再重新计算。*

### Modifier 在 Spec 中的激活

GE 是静态配置，真正施加到 ASC 上的是 `FGameplayEffectSpec`（运行时实例）。Spec 创建时会把 GE 的每个 `FGameplayModifierInfo` 实例化成 `FModifierSpec`。

#### FModifierSpec：运行时的 Modifier

```cpp
// GameplayEffectSpec.h
struct FModifierSpec
{
    FGameplayModifierInfo ModifierInfo;  // 原始配置
    float EvaluatedMagnitude;            // 已计算的数值
    FModifierHandle ModifierHandle;      // 聚合器上的句柄

    FModifierSpec(const FGameplayModifierInfo& InModifierInfo, const FGameplayEffectSpec& InSpec);
};
```

构造函数里调用 `CalculateMagnitude`：

```cpp
// GameplayEffectSpec.cpp
FModifierSpec::FModifierSpec(const FGameplayModifierInfo& InModifierInfo, const FGameplayEffectSpec& InSpec)
    : ModifierInfo(InModifierInfo)
    , EvaluatedMagnitude(InModifierInfo.ModifierMagnitude.CalculateMagnitude(InSpec))
{
}
```

**关键**：`EvaluatedMagnitude` 在构造时就算好了，后续运算直接用这个值。

#### 聚合器绑定：Modifier 如何挂到 ASC 上

Duration / Infinite 的 GE 会把 Modifier 挂到聚合器（Aggregator）上。聚合器是每个属性上的"运算中枢"，维护所有生效的 Modifier，求值时把 Base 和各条 Modifier 按规则合成 Current。

绑定发生在 `FAggregator::AddModifier`：

```cpp
// AttributeSet.cpp
FModifierHandle FAggregator::AddModifier(const FGameplayModifierSpec& InModifierSpec, const FGameplayEffectSpec& InSpec)
{
    FAggregatorModifiesChannel* Channel = GetChannel(InModifierSpec.ModifierInfo.Attribute);
    if (Channel)
    {
        FAggregatorModifier Modifier;
        Modifier.Op = InModifierSpec.ModifierInfo.ModifierOp;
        Modifier.Magnitude = InModifierSpec.EvaluatedMagnitude;
        Modifier.Source = InSpec.GetEffectContext().GetInstigatorAbilitySystemComponent();

        // 添加到 Channel 的 Modifier 列表
        int32 NewModifierIdx = Channel->Modifiers.Add(Modifier);
        return FModifierHandle(Channel, NewModifierIdx);
    }
    return FModifierHandle();
}
```

**返回的 `FModifierHandle`**：聚合器上的句柄，后续移除 Modifier 时用这个 Handle 找到对应条目。

{% mermaid %}
flowchart LR
    GE["UGameplayEffect\n（静态配置）"] -->|创建| Spec["FGameplayEffectSpec\n（运行时实例）"]
    Spec -->|实例化| ModifierSpec["FModifierSpec\n（EvaluatedMagnitude）"]
    ModifierSpec -->|AddModifier| Aggregator["FAggregator\n（聚合器）"]
    Aggregator -->|返回| Handle["FModifierHandle\n（句柄）"]
{% endmermaid %}

*图 2：从 GE 到 Spec 到 ModifierSpec，再挂到聚合器上，返回 Handle 用于后续移除。*

### 运算调用链：从 Modifier 到 Current Value

Modifier 挂到聚合器后，每次属性求值都会调用 `FAggregator::ExecuteMod`，把 Base 和所有 Modifier 合成 Current。

#### ExecuteMod 的核心逻辑

```cpp
// AttributeSet.cpp
float FAggregator::ExecuteMod(const float InBaseValue) const
{
    float Result = InBaseValue;

    // 按 Op 优先级分组执行：Multiply → Add → Override
    // Multiply
    for (const FAggregatorModifier& Modifier : MultiplyModifiers)
    {
        Result *= Modifier.Magnitude;
    }

    // Add
    for (const FAggregatorModifier& Modifier : AddModifiers)
    {
        Result += Modifier.Magnitude;
    }

    // Override（只取最后一个）
    if (OverrideModifiers.Num() > 0)
    {
        Result = OverrideModifiers.Last().Magnitude;
    }

    return Result;
}
```

**执行顺序**：
1. 先执行所有 Multiply（按添加顺序）
2. 再执行所有 Add（按添加顺序）
3. 最后执行 Override（只取最后一个，前面的都被覆盖）

**堆叠顺序**：同一 Op 的多个 Modifier，按添加时间顺序执行。先添加的先算，后添加的后算。

{% mermaid %}
flowchart TB
    Base["BaseValue"] --> Multiply["× 所有 Multiply Modifier"]
    Multiply --> Add["+ 所有 Add Modifier"]
    Add --> Override["Override Modifier（最后一个）"]
    Override --> Current["CurrentValue"]

    subgraph Modifiers["聚合器上的 Modifier 列表"]
        M1["Modifier 1 (Multiply)"]
        M2["Modifier 2 (Multiply)"]
        M3["Modifier 3 (Add)"]
        M4["Modifier 4 (Add)"]
        M5["Modifier 5 (Override)"]
    end

    Modifiers --> Multiply
    Modifiers --> Add
    Modifiers --> Override
{% endmermaid %}

*图 3：ExecuteMod 按 Op 优先级分组执行，同一 Op 内按添加顺序。*

#### 完整调用链

从 GE Apply 到 Current Value 的完整路径：

{% mermaid %}
sequenceDiagram
    participant ASC as AbilitySystemComponent
    participant Spec as FGameplayEffectSpec
    participant ModifierSpec as FModifierSpec
    participant Agg as FAggregator
    participant Attr as AttributeSet

    ASC->>Spec: ApplyGameplayEffectSpecToSelf
    Spec->>ModifierSpec: 创建 FModifierSpec
    ModifierSpec->>ModifierSpec: CalculateMagnitude
    ModifierSpec->>Agg: AddModifier（返回 Handle）
    Agg->>Agg: 挂到 Modifier 列表

    Note over ASC: 属性求值时
    ASC->>Agg: ExecuteMod
    Agg->>Attr: 读 BaseValue
    Agg->>Agg: Base × Multiply + Add → Override
    Agg->>Attr: 写 CurrentValue
{% endmermaid %}

*图 4：从 GE Apply 到 Current Value 的完整调用链。*

### 最小化实例：+10 Attack Buff

构造一个最简单的 Duration GE，只有一个 Modifier：

```cpp
// GE_AttackBuff
DurationPolicy = EGameplayEffectDurationPolicy::HasDuration;
DurationMagnitude = 10.f;  // 持续 10 秒

Modifiers[0].Attribute = AttackAttribute;
Modifiers[0].ModifierOp = EGameplayModOp::Additive;
Modifiers[0].Magnitude = 10.f;  // Scalable Float，Value = 10
```

**执行流程**：
1. `ApplyGameplayEffectSpecToSelf`：创建 Spec
2. `FModifierSpec` 构造：`EvaluatedMagnitude = 10.f`
3. `AddModifier`：挂到 Attack 属性的聚合器上
4. `ExecuteMod`：`Current = Base + 10`
5. 10 秒后 `RemoveActiveGameplayEffect`：从聚合器移除 Modifier，`Current` 恢复到 Base

这个实例覆盖了 Modifier 的核心路径：创建 → 激活 → 运算 → 移除。后面讲 DurationPolicy 时会对比 Instant vs Duration 的差异。

---

## UGameplayEffect：静态配置与蓝图友好

改数的基本单元搞清楚了，现在回头看 `UGameplayEffect` 如何配置这些 Modifier。

### UGameplayEffect 的核心字段

`UGameplayEffect` 是 Blueprintable 的 UObject，核心字段：

**基础字段**：
- `Modifiers`：`TArray<FGameplayModifierInfo>`，Modifier 列表
- `DurationPolicy`：`EGameplayEffectDurationType`，Instant / Infinite / HasDuration（下一节深挖）
- `DurationMagnitude`：`FGameplayEffectModifierMagnitude`，持续时间（秒）
- `Period`：周期执行（用于 DoT 类 GE，每隔几秒触发一次）

**高级字段**（一笔带过，预告第 4 篇）：
- `StackingType` / `StackLimit` / `StackDurationRefreshPolicy`：堆叠机制（第 4 篇）
- `GrantedTags` / `AddedTags` / `RemovedTags`：Tag 管理（第 4 篇）
- `ConditionalGameplayEffects`：条件触发（第 4 篇）
- `GrantedAbilities`：授予技能（第 4 篇）
- `Executions`：`TArray<FGameplayEffectExecutionDefinition>`，ExecutionCalculation（第 4 篇）

概念本身不玄，重点是 `DurationPolicy`——它决定了 GE 的执行语义和生命周期。

### DurationType：Instant / Infinite / HasDuration 的实现差异

`EGameplayEffectDurationType` 枚举：

```cpp
// GameplayEffect.h
enum class EGameplayEffectDurationType : uint8
{
    Instant,      // 立即执行一次
    Infinite,     // 无限持续（手动移除）
    HasDuration   // 持续一段时间
};
```

三种 Type 在源码里的实现路径完全不同。

#### Instant：立即执行、不挂聚合器

**语义**：立即执行一次、不挂聚合器、直接改 Base 或走 Execution。

**源码路径**：`ApplyGameplayEffectSpecToSelf` 中 Instant 的分支：

```cpp
// AbilitySystemComponent.cpp (简化)
FActiveGameplayEffectHandle UAbilitySystemComponent::ApplyGameplayEffectSpecToSelf(
    const FGameplayEffectSpec& Spec)
{
    const UGameplayEffect* GE = Spec.Def;
    if (GE->DurationPolicy == EGameplayEffectDurationType::Instant)
    {
        // 立即执行所有 Instant Modifier 和 Execution
        ExecuteActiveEffects(Spec);

        // Instant GE 不会留在 ActiveEffects 列表里
        return FActiveGameplayEffectHandle();
    }
    else
    {
        // Infinite / HasDuration：创建 ActiveGE，挂聚合器
        FActiveGameplayEffect* ActiveGE = new FActiveGameplayEffect(Spec);
        // ...
    }
}
```

**关键**：Instant GE 不会留在 ASC 的 `ActiveEffects` 列表里，执行完就没了。

**ExecuteActiveEffects**：遍历 Spec 的所有 Modifier，立即修改 BaseValue：

```cpp
// AbilitySystemComponent.cpp (简化)
void UAbilitySystemComponent::ExecuteActiveEffects(const FGameplayEffectSpec& Spec)
{
    for (int32 i = 0; i < Spec.Def->Modifiers.Num(); ++i)
    {
        const FGameplayModifierInfo& ModInfo = Spec.Def->Modifiers[i];
        const FModifierSpec& ModSpec = Spec.Modifiers[i];

        FGameplayAttribute Attribute = ModInfo.Attribute;
        float Magnitude = ModSpec.GetEvaluatedMagnitude();

        // Instant GE 直接改 BaseValue
        switch (ModInfo.ModifierOp)
        {
        case EGameplayModOp::AddBase:
            SetNumericAttributeBase(Attribute, GetNumericAttributeBase(Attribute) + Magnitude);
            break;
        case EGameplayModOp::Override:
            SetNumericAttributeBase(Attribute, Magnitude);
            break;
        // ... 其他 Op（Instant 场景很少用 Multiply/Divide）
        }
    }
}
```

**对比 Infinite/HasDuration**：Instant 不挂聚合器，不会参与后续的 Current 求值，直接改 Base。

#### HasDuration：挂聚合器、持续一段时间、定时移除

**语义**：挂聚合器、持续一段时间、定时移除。

**源码路径**：`ApplyGameplayEffectSpecToSelf` 中 HasDuration 的分支：

```cpp
// AbilitySystemComponent.cpp (简化)
FActiveGameplayEffectHandle UAbilitySystemComponent::ApplyGameplayEffectSpecToSelf(...)
{
    if (GE->DurationPolicy == EGameplayEffectDurationType::HasDuration)
    {
        // 创建 ActiveGE
        FActiveGameplayEffect* ActiveGE = new FActiveGameplayEffect(Spec);

        // 计算 Duration
        float Duration = 0.f;
        Spec.Def->DurationMagnitude.AttemptCalculateMagnitude(Spec, Duration);
        ActiveGE->Duration = Duration;

        // 计算开始和结束时间
        ActiveGE->StartServerWorldTime = GetWorld()->GetTimeSeconds();
        ActiveGE->EndServerWorldTime = ActiveGE->StartServerWorldTime + Duration;

        // 挂聚合器
        for (int32 i = 0; i < Spec.Def->Modifiers.Num(); ++i)
        {
            AddModifierToAggregator(*ActiveGE, i);
        }

        // 添加到 ActiveEffects 列表
        ActiveEffects.Add(ActiveGE);

        return ActiveGE->Handle;
    }
}
```

**Duration 字段的计算**：`DurationMagnitude` 是 `FGameplayEffectModifierMagnitude` 类型，支持四种计算方式（ScalableFloat、AttributeBased、CustomCalculation、SetByCaller），和 Modifier 的 Magnitude 一样。

**定时移除**：`CheckActiveGameplayEffects`（每帧调用）：

```cpp
// AbilitySystemComponent.cpp (简化)
void UAbilitySystemComponent::CheckActiveGameplayEffects()
{
    float CurrentTime = GetWorld()->GetTimeSeconds();
    for (FActiveGameplayEffect* ActiveGE : ActiveEffects)
    {
        if (ActiveGE->DurationPolicy != EGameplayEffectDurationType::Infinite)
        {
            if (ActiveGE->EndServerWorldTime <= CurrentTime)
            {
                // 时间到了，移除 GE
                RemoveActiveGameplayEffect(ActiveGE->Handle);
            }
        }
    }
}
```

**移除逻辑**：从聚合器移除 Modifier，Current 恢复到 Base：

```cpp
// AbilitySystemComponent.cpp (简化)
void UAbilitySystemComponent::RemoveActiveGameplayEffect(FActiveGameplayEffectHandle Handle)
{
    FActiveGameplayEffect* ActiveGE = GetActiveGameplayEffect(Handle);
    if (ActiveGE)
    {
        // 从聚合器移除所有 Modifier
        for (int32 i = 0; i < ActiveGE->Spec.Def->Modifiers.Num(); ++i)
        {
            RemoveModifierFromAggregator(*ActiveGE, i);
        }

        // 从 ActiveEffects 列表删除
        ActiveEffects.Remove(ActiveGE);
    }
}
```

#### Infinite：挂聚合器、手动移除、无 Duration

**语义**：挂聚合器、持续到手动移除、无 Duration。

**源码路径**：和 HasDuration 的分支一样，只是 `Duration = -1`，没有 `EndServerWorldTime`：

```cpp
// AbilitySystemComponent.cpp (简化)
if (GE->DurationPolicy == EGameplayEffectDurationType::Infinite)
{
    FActiveGameplayEffect* ActiveGE = new FActiveGameplayEffect(Spec);
    ActiveGE->Duration = -1.f;  // 无限持续

    // 挂聚合器、添加到 ActiveEffects（和 HasDuration 一样）
    // ...
}
```

**手动移除**：调用 `RemoveActiveGameplayEffect`，和 HasDuration 移除的逻辑一致。

#### 对比三种 Type 的源码分支

{% mermaid %}
flowchart TB
    Apply["ApplyGameplayEffectSpecToSelf"] --> Type{DurationPolicy}

    Type -->|Instant| Exec["ExecuteActiveEffects\n立即执行"]
    Exec --> Done["执行完结束\n不创建 ActiveGE"]

    Type -->|HasDuration| Create["创建 FActiveGameplayEffect"]
    Create --> Duration["计算 Duration\nEndServerWorldTime"]
    Duration --> Add["挂聚合器"]
    Add --> List["添加到 ActiveEffects"]
    List --> Check["每帧 CheckActiveGameplayEffects"]
    Check --> Remove["EndServerWorldTime 到了 → RemoveActiveGameplayEffect"]

    Type -->|Infinite| Create2["创建 FActiveGameplayEffect\nDuration = -1"]
    Create2 --> Add2["挂聚合器"]
    Add2 --> List2["添加到 ActiveEffects"]
    List2 --> Manual["手动调用 RemoveActiveGameplayEffect"]
{% endmermaid %}

*图 5：三种 DurationType 的源码分支。Instant 立即执行、HasDuration 定时移除、Infinite 手动移除。*

### GE 的蓝图可配置性

`UGameplayEffect` 是 Blueprintable，设计意图：让策划配置 GE、不写 C++。

**Blueprintable 的好处**：
- 策划可以在蓝图编辑器里配置 Modifier（选属性、选 Op、配数值）
- 可以配置 Duration、Period、Stacking、Tags 等参数
- 可以继承 GE 蓝图，做变体（比如"火球术伤害 GE" → "大火球术伤害 GE"）

**强调**：GE 是"静态配置"，Spec 才是"运行时实例"。同一个 GE 蓝图可以施加多次，每次都是独立的 Spec 和 ActiveGE。

### Instant vs HasDuration 对比实例

构造两个 GE，对比 Apply 路径差异：

**GE_Instant**：
```cpp
DurationPolicy = EGameplayEffectDurationType::Instant;
Modifiers[0].Attribute = AttackAttribute;
Modifiers[0].ModifierOp = EGameplayModOp::AddBase;
Modifiers[0].ModifierMagnitude = ScalableFloat(10.f);
```

**GE_HasDuration**：
```cpp
DurationPolicy = EGameplayEffectDurationType::HasDuration;
DurationMagnitude = ScalableFloat(10.f);  // 持续 10 秒
Modifiers[0].Attribute = AttackAttribute;
Modifiers[0].ModifierOp = EGameplayModOp::AddBase;
Modifiers[0].ModifierMagnitude = ScalableFloat(10.f);
```

**Apply 路径对比**：

| 步骤 | GE_Instant | GE_HasDuration |
|------|-----------|-------------|
| Apply | ExecuteActiveEffects | 创建 ActiveGE |
| Modifier | 直接改 BaseValue（+10） | 挂聚合器（Current = Base + 10） |
| ActiveEffects | 不加入列表 | 加入列表，有 Handle |
| 移除 | 无（执行完就没了） | 10秒后 CheckActiveGameplayEffects 移除 |
| 移除后 | Base 已改，不回退 | 从聚合器移除，Current 恢复到 Base |

**关键差异**：
- Instant 改 BaseValue，HasDuration 改 Current（挂聚合器）
- Instant 不留在 ActiveEffects，HasDuration 会留到时间结束
- HasDuration 移除后 Current 会回退，Instant 改的 BaseValue 是永久性的（除非手动改回去）

这个差异在第 4 篇讲网络预测时会展开：Instant GE 客户端预测执行后，服务器对账容易；HasDuration GE 客户端挂聚合器，服务器移除时要对账。

---
{
    if (GE->DurationPolicy == EGameplayEffectDurationPolicy::HasDuration)
    {
        FActiveGameplayEffect* ActiveGE = new FActiveGameplayEffect(Spec);

        // 计算结束时间
        ActiveGE->StartWorldTime = GetWorld()->GetTimeSeconds();
        ActiveGE->Duration = Spec.GetDuration();
        ActiveGE->EndWorldTime = ActiveGE->StartWorldTime + ActiveGE->Duration;

        // 挂聚合器
        for (const FModifierSpec& ModSpec : Spec.Modifiers)
        {
            FAggregator* Agg = GetAggregator(ModSpec.ModifierInfo.Attribute);
            ActiveGE->ModifierHandles.Add(Agg->AddModifier(ModSpec, Spec));
        }

        // 添加到 ActiveEffects 列表
        ActiveEffects.Add(ActiveGE);
    }
}
```

**Duration 字段的计算**：`FGameplayEffectSpec::GetDuration`：

```cpp
// GameplayEffectSpec.cpp
float FGameplayEffectSpec::GetDuration() const
{
    if (Def->DurationPolicy == EGameplayEffectDurationPolicy::HasDuration)
    {
        return Def->DurationMagnitude.GetValueAtLevel(Level);
    }
    return -1.f;  // Infinite 返回 -1
}
```

**定时移除**：`CheckActiveGameplayEffects`（每帧调用）：

```cpp
// AbilitySystemComponent.cpp
void UAbilitySystemComponent::CheckActiveGameplayEffects()
{
    float CurrentTime = GetWorld()->GetTimeSeconds();
    for (FActiveGameplayEffect* ActiveGE : ActiveEffects)
    {
        if (ActiveGE->EndWorldTime <= CurrentTime)
        {
            // 时间到了，移除 GE
            RemoveActiveGameplayEffect(ActiveGE->Handle);
        }
    }
}
```

**移除逻辑**：从聚合器移除 Modifier，Current 恢复到 Base：

```cpp
// AbilitySystemComponent.cpp
void UAbilitySystemComponent::RemoveActiveGameplayEffect(FActiveGameplayEffectHandle Handle)
{
    FActiveGameplayEffect* ActiveGE = GetActiveGameplayEffect(Handle);
    if (ActiveGE)
    {
        // 从聚合器移除 Modifier
        for (const FModifierHandle& ModHandle : ActiveGE->ModifierHandles)
        {
            FAggregator* Agg = GetAggregator(ModHandle.Attribute);
            Agg->RemoveModifier(ModHandle);
        }

        // 从 ActiveEffects 列表删除
        ActiveEffects.Remove(ActiveGE);
    }
}
```

#### Infinite：挂聚合器、手动移除、无 Duration

**语义**：挂聚合器、持续到手动移除、无 Duration。

**源码路径**：和 Duration 的分支基本一样，只是 `Duration = -1`，没有 `EndWorldTime`：

```cpp
// AbilitySystemComponent.cpp
if (GE->DurationPolicy == EGameplayEffectDurationPolicy::Infinite)
{
    FActiveGameplayEffect* ActiveGE = new FActiveGameplayEffect(Spec);
    ActiveGE->Duration = -1.f;  // 无限持续
    // 挂聚合器、添加到 ActiveEffects（和 Duration 一样）
}
```

**手动移除**：调用 `RemoveActiveGameplayEffect`，和 Duration 移除的逻辑一致。

#### 对比三种 Policy 的源码分支

{% mermaid %}
flowchart TB
    Apply["ApplyGameplayEffectSpecToSelf"] --> Policy{DurationPolicy}

    Policy -->|Instant| Exec["ExecuteActiveEffects\n立即执行"]
    Exec --> Done["执行完结束\n不创建 ActiveGE"]

    Policy -->|Duration| Create["创建 FActiveGameplayEffect"]
    Create --> Duration["计算 Duration / EndTime"]
    Duration --> Add["挂聚合器\n返回 Handle"]
    Add --> List["添加到 ActiveEffects"]
    List --> Check["每帧 CheckActiveGameplayEffects"]
    Check --> Remove["EndTime 到了 → RemoveActiveGameplayEffect"]

    Policy -->|Infinite| Create2["创建 FActiveGameplayEffect\nDuration = -1"]
    Create2 --> Add2["挂聚合器"]
    Add2 --> List2["添加到 ActiveEffects"]
    List2 --> Manual["手动调用 RemoveActiveGameplayEffect"]
{% endmermaid %}

*图 5：三种 DurationPolicy 的源码分支。Instant 立即执行、Duration 定时移除、Infinite 手动移除。*

### GE 的蓝图可配置性

`UGameplayEffect` 是 Blueprintable，设计意图：让策划配置 GE、不写 C++。

**Blueprintable 的好处**：
- 策划可以在蓝图编辑器里配置 Modifier（选属性、选 Op、配数值）
- 可以配置 Duration、Period、Stacking、Tags 等参数
- 可以继承 GE 蓝图，做变体（比如"火球术伤害 GE" → "大火球术伤害 GE"）

**强调**：GE 是"静态配置"，Spec 才是"运行时实例"。同一个 GE 蓝图可以施加多次，每次都是独立的 Spec 和 ActiveGE。

### Instant vs Duration 对比实例

构造两个 GE，对比 Apply 路径差异：

**GE_Instant**：
```cpp
DurationPolicy = Instant;
Modifiers[0].Attribute = AttackAttribute;
Modifiers[0].ModifierOp = Additive;
Modifiers[0].Magnitude = 10.f;
```

**GE_Duration**：
```cpp
DurationPolicy = HasDuration;
DurationMagnitude = 10.f;  // 持续 10 秒
Modifiers[0].Attribute = AttackAttribute;
Modifiers[0].ModifierOp = Additive;
Modifiers[0].Magnitude = 10.f;
```

**Apply 路径对比**：

| 步骤 | GE_Instant | GE_Duration |
|------|-----------|-------------|
| Apply | ExecuteActiveEffects | 创建 ActiveGE |
| Modifier | 直接改 Base（+10） | 挂聚合器（Current = Base + 10） |
| ActiveEffects | 不加入列表 | 加入列表，有 Handle |
| 移除 | 无（执行完就没了） | 10秒后 CheckActiveGameplayEffects 移除 |
| 移除后 | Base 已改，不回退 | 从聚合器移除，Current 恢复到 Base |

**关键差异**：
- Instant 改 Base，Duration 改 Current（挂聚合器）
- Instant 不留在 ActiveEffects，Duration 会留到时间结束
- Duration 移除后 Current 会回退，Instant 改的 Base 是永久性的（除非手动改回去）

这个差异在第 4 篇讲网络预测时会展开：Instant GE 客户端预测执行后，服务器对账容易；Duration GE 客户端挂聚合器，服务器移除时要对账。

---

## FGameplayEffectSpec：运行时实例

`UGameplayEffect` 是静态配置，真正施加到 ASC 上的是 `FGameplayEffectSpec`（运行时实例）。

### Spec 的创建：从 GE CDO 到运行时实例

`FGameplayEffectSpec::Create` 是创建 Spec 的入口：

```cpp
// GameplayEffectSpec.cpp
FGameplayEffectSpec FGameplayEffectSpec::Create(
    const UGameplayEffect* InGE,
    const FGameplayEffectContext& InContext,
    float InLevel)
{
    FGameplayEffectSpec Spec;

    // 1. 从 GE CDO 复制字段到 Spec
    Spec.Def = InGE;
    Spec.Level = InLevel;
    Spec.EffectContext = InContext;

    // 2. 实例化 ModifierSpecs
    for (const FGameplayModifierInfo& ModifierInfo : InGE->Modifiers)
    {
        Spec.Modifiers.Add(FModifierSpec(ModifierInfo, Spec));
    }

    // 3. 初始化 Handle、Duration、StartWorldTime
    Spec.Handle = FActiveGameplayEffectHandle::GenerateNewHandle();
    Spec.Duration = InGE->GetDuration();

    return Spec;
}
```

**三个关键步骤**：
1. **从 GE CDO 复制字段**：`Def` 指向 GE 的 CDO（Class Default Object）
2. **实例化 ModifierSpecs**：调用 `FModifierSpec` 构造，算出 `EvaluatedMagnitude`
3. **初始化运行时状态**：Handle、Duration 等

#### Spec 持有的运行时状态

```cpp
// GameplayEffectSpec.h
struct FGameplayEffectSpec
{
    const UGameplayEffect* Def;  // GE 的 CDO
    FGameplayEffectContext EffectContext;  // 上下文
    TArray<FModifierSpec> Modifiers;  // 实例化的 ModifierSpecs

    float Level;  // 当前 Level（用于 Magnitude 缩放）
    float Duration;  // 实际持续时间（从 GE 的 Duration 字段计算）
    FActiveGameplayEffectHandle Handle;  // 唯一标识
};
```

**关键字段**：
- `Handle`：`FActiveGameplayEffectHandle`（唯一标识，用于后续管理）
- `Level`：当前 Level（用于 Scalable Float 的 Level 缩放）
- `Duration`：实际持续时间（从 GE 的 `DurationMagnitude` + Context 计算）
- `EffectContext`：施放者、来源对象、技能等上下文信息

#### ModifierSpecs 的实例化

`FModifierSpec` 的构造：

```cpp
// GameplayEffectSpec.cpp
FModifierSpec::FModifierSpec(const FGameplayModifierInfo& InModifierInfo, const FGameplayEffectSpec& InSpec)
    : ModifierInfo(InModifierInfo)
    , EvaluatedMagnitude(InModifierInfo.ModifierMagnitude.CalculateMagnitude(InSpec))
{
}
```

**关键**：`CalculateMagnitude` 在构造时调用，算出 `EvaluatedMagnitude`。这个值在后续运算中不会再变（除非 GE 本身配置了 Dynamic Magnitude）。

### Spec 的上下文：FGameplayEffectContext

`FGameplayEffectContext` 承载 GE 施加时的上下文信息：

```cpp
// GameplayEffectContext.h
struct FGameplayEffectContext
{
    TWeakObjectPtr<UObject> Instigator;  // 施放者（谁施加了这个 GE）
    TWeakObjectPtr<UObject> SourceObject;  // 来源对象（比如技能、道具）
    TWeakObjectPtr<UAbilitySystemComponent> InstigatorAbilitySystemComponent;  // 施放者的 ASC
    TWeakObjectPtr<AActor> SourceActor;  // 来源 Actor
    TWeakObjectPtr<AActor> TargetActor;  // 目标 Actor（施加到谁身上）

    FGameplayAbilitySpecHandle AbilitySpecHandle;  // 触发 GE 的技能 Spec
    FGameplayTagContainer SourceTags;  // 来源的 Tags
    FGameplayTagContainer TargetTags;  // 目标的 Tags

    // ...
};
```

**Context 的用途**：
- `Instigator` / `SourceActor`：用于 Attribute Capture（从 Source 的 ASC 捕获属性）
- `AbilitySpecHandle`：用于 ExecutionCalculation（拿到触发 GE 的技能）
- `SourceTags` / `TargetTags`：用于条件判断（比如"目标有免疫 Tag 则不施加")

**Context 如何在 Spec 创建时传入**：

```cpp
// AbilitySystemComponent.cpp
FActiveGameplayEffectHandle UAbilitySystemComponent::ApplyGameplayEffectSpecToSelf(
    const FGameplayEffectSpec& Spec)
{
    // Spec 已经在 Create 时传入了 Context
    const FGameplayEffectContext& Context = Spec.EffectContext;
    // ...
}
```

**Context 如何在 Modifier 运算时使用**：

Attribute Based Magnitude 的 Capture：

```cpp
// GameplayEffectModifierMagnitude.cpp
float FAttributeBasedFloat::Calculate(const FGameplayEffectSpec& Spec) const
{
    // 从 Spec.EffectContext 拿 Source/Target 的 ASC
    UAbilitySystemComponent* SourceASC = Spec.EffectContext.GetInstigatorAbilitySystemComponent();
    UAbilitySystemComponent* TargetASC = Spec.EffectContext.GetTargetActor()->GetAbilitySystemComponent();

    // 从 ASC 捕获属性值
    float CapturedValue = AttributeToCapture.GetCapturedAttributeMagnitude(SourceASC, TargetASC);
    return CapturedValue * Coefficient;
}
```

### Attribute Capture：从 Source/Target 的 ASC 捕获属性值

`FGameplayEffectAttributeCaptureSpec` 的设计意图：在 Spec 创建时捕获 Source/Target 的属性值，供后续运算使用。

```cpp
// GameplayEffectAttributeCaptureSpec.h
struct FGameplayEffectAttributeCaptureSpec
{
    FGameplayAttribute Attribute;  // 要捕获的属性
    EGameplayEffectAttributeCaptureSource Source;  // Source 还是 Target
    bool bSnapshot;  // 是否 Snapshot（立即捕获）

    float CapturedValue;  // 捕获的值
    bool bCaptured;  // 是否已捕获

    void CaptureAttribute(const FGameplayEffectSpec& Spec);
    float GetCapturedAttributeMagnitude() const;
};
```

**Capture 的时机**：

- **Snapshot（bSnapshot = true）**：Spec 创建时立即捕获，后续运算用这个快照值
- **Non-Snapshot（bSnapshot = false）**：运算时实时从 Source/Target 的 ASC 取值

**Snapshot vs Non-Snapshot 的差异**（预告第 4 篇）：

| 类型 | Snapshot | Non-Snapshot |
|------|----------|--------------|
| 捕获时机 | Spec 创建时 | 运算时 |
| 数值稳定性 | 固定不变 | 实时变化 |
| 网络预测 | 客户端和服务器用同一个快照 | 客户端和服务器可能取到不同的值 |
| 适用场景 | "技能释放时的属性值" | "目标当前的属性值" |

第 4 篇讲网络预测时会展开 Snapshot vs Non-Snapshot 的对账问题。

### Spec 与 ActiveGameplayEffect：ASC 的生命周期管理

`FActiveGameplayEffect` 是 ASC 包装 Spec 的结构：

```cpp
// AbilitySystemComponent.h
struct FActiveGameplayEffect
{
    FGameplayEffectSpec Spec;  // 运行时实例
    float StartWorldTime;  // 施加时刻
    float Duration;  // 持续时间
    float EndWorldTime;  // 结束时刻
    FActiveGameplayEffectHandle Handle;  // 唯一标识

    TArray<FModifierHandle> ModifierHandles;  // 聚合器上的 Handle
};
```

**ASC 如何管理 ActiveGE**：

```cpp
// AbilitySystemComponent.h
class UAbilitySystemComponent
{
    TArray<FActiveGameplayEffect*> ActiveEffects;  // 当前生效的 GE 列表
};
```

**Duration GE 的剩余时间计算**：

```cpp
// AbilitySystemComponent.cpp
float FActiveGameplayEffect::GetRemainingTime(float CurrentWorldTime) const
{
    return EndWorldTime - CurrentWorldTime;
}
```

**定时移除**：`CheckActiveGameplayEffects`（每帧调用）：

```cpp
// AbilitySystemComponent.cpp
void UAbilitySystemComponent::CheckActiveGameplayEffects()
{
    float CurrentTime = GetWorld()->GetTimeSeconds();
    for (FActiveGameplayEffect* ActiveGE : ActiveEffects)
    {
        if (ActiveGE->EndWorldTime <= CurrentTime)
        {
            RemoveActiveGameplayEffect(ActiveGE->Handle);
        }
    }
}
```

**不展开**：ActiveGE 的详细管理逻辑（Stacking、网络同步）留给第 4 篇。

### 追踪 Duration GE 的完整路径

从 Apply → Spec 创建 → ActiveGE 包装 → ASC 管理 → Remove：

{% mermaid %}
sequenceDiagram
    participant GA as GameplayAbility
    participant ASC as AbilitySystemComponent
    participant Spec as FGameplayEffectSpec
    participant ActiveGE as FActiveGameplayEffect
    participant Agg as FAggregator
    participant Attr as AttributeSet

    GA->>ASC: ApplyGameplayEffectSpecToSelf
    ASC->>Spec: FGameplayEffectSpec::Create(GE, Context, Level)
    Spec->>Spec: 实例化 ModifierSpecs（CalculateMagnitude）
    ASC->>ActiveGE: 创建 FActiveGameplayEffect(Spec)
    ActiveGE->>ActiveGE: 计算 StartWorldTime / EndWorldTime
    ActiveGE->>Agg: AddModifier（返回 Handle）
    Agg->>Attr: 挂到聚合器
    ASC->>ASC: ActiveEffects.Add(ActiveGE)

    Note over ASC: 每帧 CheckActiveGameplayEffects
    ASC->>ActiveGE: GetRemainingTime
    ActiveGE->>ASC: EndWorldTime <= CurrentTime → RemoveActiveGameplayEffect
    ASC->>Agg: RemoveModifier(Handle)
    Agg->>Attr: 从聚合器移除，Current 恢复到 Base
    ASC->>ASC: ActiveEffects.Remove(ActiveGE)
{% endmermaid %}

*图 6：Duration GE 从 Apply 到 Remove 的完整路径。*

### GE CDO → Spec → ActiveGE → ASC 管理的流程图

{% mermaid %}
flowchart TB
    subgraph Config["配置层"]
        GE["UGameplayEffect CDO\n（静态配置）"]
        Modifier["Modifiers 列表\n（ModifierInfo）"]
    end

    subgraph Runtime["运行时实例"]
        Spec["FGameplayEffectSpec\n（Create 时实例化）"]
        ModSpec["FModifierSpec\n（EvaluatedMagnitude）"]
        Context["FGameplayEffectContext\n（Instigator / Source）"]
    end

    subgraph Management["ASC 管理"]
        ActiveGE["FActiveGameplayEffect\n（包装 Spec）"]
        Handle["FModifierHandle\n（聚合器句柄）"]
    end

    subgraph Aggregator["聚合器"]
        Agg["FAggregator\n（运算中枢）"]
        ModList["Modifier 列表\n（挂载）"]
    end

    GE --> Spec
    Modifier --> ModSpec
    Context --> Spec

    Spec --> ActiveGE
    ModSpec --> Handle
    Handle --> ModList

    ActiveGE --> ASC["ASC.ActiveEffects 列表"]
    Agg --> Attr["AttributeSet\n（属性值）"]
    ModList --> Agg

    ASC -->|每帧 Check| Remove["RemoveActiveGameplayEffect"]
    Remove -->|RemoveModifier| ModList
{% endmermaid %}

*图 7：从 GE CDO 到 Spec 到 ActiveGE，再到 ASC 和聚合器的完整流程。*

---

## 小结

这篇从 Modifier 的"改数基本单元"开始，到 GE 的静态配置、运行时实例、DurationPolicy 的实现差异，把 GameplayEffect 改属性的核心逻辑串了一遍。总结以下要点：

- **Modifier**：改数的基本单元
  - Magnitude 的三种计算方式：Scalable Float（CurveTable 查表 + Level 缩放）、Attribute Based（从 Source/Target 捕获属性值）、Custom Calculation（自定义逻辑）
  - 聚合器绑定：`AddModifier` 挂到聚合器上，返回 `FModifierHandle`
  - 运算调用链：`ExecuteMod` → Base + Modifier → Current（Op 优先级：Multiply → Add → Override）

- **GE 定义**：静态配置
  - 核心字段：`Modifiers`、`DurationPolicy`、`Duration`、`Period`
  - Blueprintable 的设计意图：让策划配置 GE、不写 C++
  - 强调：GE 是"静态配置"，Spec 才是"运行时实例"

- **Spec**：运行时实例
  - 创建：`FGameplayEffectSpec::Create` → 从 GE CDO 复制字段 → 实例化 ModifierSpecs
  - 上下文：`FGameplayEffectContext`（Instigator、SourceObject、Ability 等）
  - Attribute Capture：Snapshot（创建时捕获）vs Non-Snapshot（运算时取值）
  - 状态：`Handle`、`Level`、`Duration`、`StartWorldTime`

- **DurationPolicy**：Instant / Duration / Infinite 的实现差异
  - Instant：立即执行、不挂聚合器、直接改 Base、不留在 ActiveEffects
  - Duration：挂聚合器、持续一段时间、定时移除（CheckActiveGameplayEffects）
  - Infinite：挂聚合器、手动移除、Duration = -1

### 阅读建议

建议读者在源码中追踪以下路径，对照最小化 GE 实例调试：

1. **Modifier 的创建与运算**：
   - `FGameplayEffectSpec::Create` → `FModifierSpec` 构造 → `CalculateMagnitude`
   - `FAggregator::AddModifier` → `ExecuteMod`

2. **DurationPolicy 的分支**：
   - `ApplyGameplayEffectSpecToSelf` → switch `DurationPolicy`
   - Instant：`ExecuteActiveEffects` → 直接改 Base
   - Duration：创建 ActiveGE → 挂聚合器 → `CheckActiveGameplayEffects` → 移除

3. **对比 Instant vs Duration**：
   - 构造两个 GE（GE_Instant 和 GE_Duration），Modifier 配置一样
   - Apply 后观察：Instant 改 Base、Duration 改 Current
   - Duration 移除后观察：Current 恢复到 Base

4. **追踪 Attribute Based Magnitude**：
   - 配置一个"强度 = 目标当前生命值 × 0.1"的 Modifier
   - 在 `FAttributeBasedFloat::Calculate` 里打断点，观察 Capture 的过程

---

## 收尾

好了，以上就是 GameplayEffect 源码导读的第一部分，从 Modifier 的改数机制到 GE 的静态配置、运行时实例、DurationPolicy 的实现差异。改属性这条线的核心逻辑已经串清楚，后面再读 ASC 的管理、网络预测、Stacking 就有基础了。

下一篇会把 GameplayEffect 的高级特性讲完：

- **Stacking 机制**：堆叠计数、刷新策略（Refresh / Reset）、堆叠上限、堆叠对 Modifier 运算的影响（StackCount 如何参与运算）
- **ExecutionCalculation**：自定义执行逻辑、Exec 与 Modifier 的协作、Exec 的调用时机、Exec 如何写输出（AddOutputModifier）
- **GE 组件**：Tags（Granted / Added / Removed）、ConditionalGameplayEffects（条件触发）、GrantedAbilities（授予技能）、免疫与免疫 Tag

我们下篇见。