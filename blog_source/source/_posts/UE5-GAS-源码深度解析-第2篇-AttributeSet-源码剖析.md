---
title: UE5 GAS 源码深度解析 | 第2篇：AttributeSet 源码导读
date: 2026-03-21 10:00:00
categories:
  - 技术漫谈
  - 游戏开发
tags: [UE5, GAS, 源码解析, 游戏开发, AttributeSet]
cover: 2026/03/21/UE5-GAS-源码深度解析-第2篇-AttributeSet-源码剖析/gas-part2-cover.png
cover_type: img
top_img: 2026/03/21/UE5-GAS-源码深度解析-第2篇-AttributeSet-源码剖析/gas-part2-banner.png
---

## 前言

[第 1 篇](/2026/03/10/UE5-GAS-源码深度解析-第1篇-整体架构与设计思想/)把 GAS 的骨架串过一遍：`UAbilitySystemComponent`（ASC）管着能力、效果、属性与标签；真正决定「数值长什么样」的，是 `UAttributeSet` 和它的子类。这篇接着从源码里看：属性相关的几个核心类型、`UAttributeSet` 在 ASC 里怎么挂、数从哪进从哪出，以及改数时会踩到哪些回调。

上一篇文末原本想下一篇先写 ASC。属性这东西又薄又底层，Effect、预测、复制几乎都会碰到，所以这篇先把 AttributeSet 交代清楚，后面再读 GameplayEffect 和网络会省不少力气。

### 版本说明

- 行文以 **Unreal Engine 5.7** 插件源码为准，和你本地不一致的地方以你手里的代码为准。
- 主要会翻：
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/AttributeSet.h`
  - `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Private/AttributeSet.cpp`（`InitFromMetaDataTable`、`FAttributeSetInitterDiscreteLevels::InitAttributeSetDefaults`、`FGameplayAttributeData`、`PreNetReceive` / `PostNetReceive` 等）
  - `AbilitySystemComponent.h` / `AbilitySystemComponent.cpp`（注册、聚合器、复制通知等）
- Meta Attribute 和伤害管道示例来自 [GASDocumentation](https://github.com/tranek/GASDocumentation)，和 Lyra 的 `LyraHealthSet` 很像，适合对照。

类名、函数名建议在上述文件里搜一下，边看边对。

---

## AttributeSet 在架构里扮演什么角色

`UAttributeSet` 就是一个普通的 `UObject`，一般以外层 `UAbilitySystemComponent` 为 `Outer` 创建，生命周期跟着 ASC。它不回答「谁有权改我」「要不要同步」——那是 ASC 和 GameplayEffect 管线的事；它更像带几个钩子的数据壳子，数值要变或刚变完时，你可以往里塞夹紧、派生属性、统计之类的项目逻辑。

{% mermaid %}
flowchart TB
  subgraph ASC["UAbilitySystemComponent"]
    Index["属性索引\nFGameplayAttribute → 聚合器"]
    AS1["UAttributeSet 子对象 1"]
    AS2["UAttributeSet 子对象 2"]
  end
  GE["GameplayEffect / Execution"]
  GE -->|经 ASC 写入| Index
  Index --> AS1
  Index --> AS2
  AS1 -->|Pre/Post 回调| Hooks["Clamp / 派生 / 日志"]
{% endmermaid %}

*图 1：AttributeSet 挂在 ASC 下面；外面改数通常还是走 ASC 和聚合器，而不是手改字段。*

---

## 基础数据结构

在深入 `UAttributeSet` 之前，先把两个最常用的类型对齐。

### FGameplayAttributeData：Base 与 Current

`FGameplayAttributeData` 是属性在内存里的存法，源码里两个 `float` 加 Getter/Setter（`AttributeSet.cpp`）：

```cpp
// AttributeSet.cpp，FGameplayAttributeData 的读写
float FGameplayAttributeData::GetCurrentValue() const { return CurrentValue; }
void FGameplayAttributeData::SetCurrentValue(float NewValue) { CurrentValue = NewValue; }
float FGameplayAttributeData::GetBaseValue() const { return BaseValue; }
void FGameplayAttributeData::SetBaseValue(float NewValue) { BaseValue = NewValue; }
```

可以粗略理解成：

- **CurrentValue**：玩法里真正拿来算、拿来展示的值，由 Base 和 ASC 上的 Modifier 管线（聚合器）一起算出来。
- **BaseValue**：叠算的锚点。Duration / Infinite 那类 GE 的 Modifier 往往是在「不直接弄脏长期基准」的前提下参与运算；Instant GE 则常常把某次改动写进 Base（比如永久升级），后面别的 GE 都从新 Base 接着叠。

拆开写，是为了把「随 Buff 来去的临时修正」和「该长期留下的基准变化」分开：Buff 摘掉时，才有机会按 GE 的规则回退，而不是改乱了就对不上账。

![](gas-base-current.png)

*图 2：BaseValue 与 CurrentValue 分工示意；Current 由 Base 与聚合器上的 Modifier 共同决定。*

举个例子：有个 Buff 给 `Damage` 临时 +10。GE 若是 Duration 或 Infinite，这次加算挂在 Modifier 链上参与运算；Buff 结束，框架可以按规则撤掉这条贡献。若是角色升级那种永久改动，通常会走 Instant（或等价路径），把变化写进 BaseValue——那就没有「同一个 GE 自动帮你回退」这回事了。

所以：**平时改属性，尽量走施加 GameplayEffect（或 ASC 提供的、和管线一致的路径），不要动不动就 `SetBaseValue` / `SetCurrentValue`。** 绕过 Modifier 栈和回退语义，预测、复制和调试也容易一起歪。只有初始化、迁数据，或者你非常清楚自己在干什么的时候，再考虑直接写裸值。

### FGameplayAttribute：句柄、反射、跟 GE 解耦

`FGameplayAttribute` 不是又一个 float 包装，而是把 `FProperty`*（以及它属于哪种 `UAttributeSet` 子类）包起来的句柄。ASC、GameplayEffect、ExecutionCalculation 里大量 API 都拿它当参数；子类里很多虚函数也是围着它转的：

```cpp
virtual void PreAttributeChange(const FGameplayAttribute& Attribute, float& NewValue) { }
virtual void PostAttributeChange(const FGameplayAttribute& Attribute, float OldValue, float NewValue) { }

virtual void PreAttributeBaseChange(const FGameplayAttribute& Attribute, float& NewValue) const { }
virtual void PostAttributeBaseChange(const FGameplayAttribute& Attribute, float OldValue, float NewValue) const { }

virtual void OnAttributeAggregatorCreated(const FGameplayAttribute& Attribute, FAggregator* NewAggregator) const { }
```

为啥 API 里不直接传 `FGameplayAttributeData&`？大致有三条理由：

1. 跟 UE 反射绑在一起：背后是 `FindFieldChecked` 一类拿到的 `FProperty`，配合 `UPROPERTY` 能做编辑器面板、Tooltip、Attribute Capture 下拉，复制和调试也吃同一套元数据。
2. 比到处手写字符串当键稳：用反射当键，重构时少踩「改了一处漏了一处、运行时才炸」的坑。
3. GE 的 Modifier 只拿「句柄 + 运算类型（Op）」，不必绑死某个 ASC 实例、某块子对象上的字段，Effect 和具体 `AttributeSet` 实现可以拆开。同一句柄在不同 ASC 上，仍然对应各自子对象里同名字段。

子类里一般用宏注册访问器。工程里常见的是 `ATTRIBUTE_ACCESSORS`（在 `AttributeSet.h` 里展开成一串 `GAMEPLAYATTRIBUTE_*`）；每个 `FGameplayAttributeData` 成员后面跟一组即可：

```cpp
#define ATTRIBUTE_ACCESSORS(ClassName, PropertyName) \
  GAMEPLAYATTRIBUTE_PROPERTY_GETTER(ClassName, PropertyName) \
  GAMEPLAYATTRIBUTE_VALUE_GETTER(PropertyName) \
  GAMEPLAYATTRIBUTE_VALUE_SETTER(PropertyName) \
  GAMEPLAYATTRIBUTE_VALUE_INITTER(PropertyName)

ATTRIBUTE_ACCESSORS(UMyHealthSet, Health)
```

一个 ASC 上可以挂多套 AttributeSet（例如 `UBasicAttributes` + `UCombatAttributes`），初始化时 ASC 会扫一遍并注册。`GetOrCreateAttributeSubobject` 在缺类型时会 `NewObject` 再 `AddSpawnedAttribute`，是运行时补挂子集的常用入口：

```c++
const UAttributeSet* UAbilitySystemComponent::GetOrCreateAttributeSubobject(TSubclassOf<UAttributeSet> AttributeClass)
{
	AActor* OwningActor = GetOwner();
	const UAttributeSet* MyAttributes = nullptr;
	if (OwningActor && AttributeClass)
	{
		MyAttributes = GetAttributeSubobject(AttributeClass);
		if (!MyAttributes)
		{
			UAttributeSet* Attributes = NewObject<UAttributeSet>(OwningActor, AttributeClass);
			AddSpawnedAttribute(Attributes);
			MyAttributes = Attributes;
		}
	}

	return MyAttributes;
}
```

### UAttributeSet：属性的集合

`UAttributeSet` 按设计把若干 `FGameplayAttribute` / `FGameplayAttributeData` 收成一类，概念本身不玄。下面几块是写项目、读源码时最容易卡住的地方。

#### 属性修改时会叫到谁

改数过程中可能触发的接口大致有这些：

- `PreGameplayEffectExecute` / `PostGameplayEffectExecute`：走 GameplayEffect 的 Execute 路径时，在一次修改前后触发。
- `PreAttributeChange` / `PostAttributeChange`：改 CurrentValue 前后。
- `PreAttributeBaseChange` / `PostAttributeBaseChange`：改 BaseValue 前后。

容易误解的几件事：

1. 直接 `SetCurrentValue` / `SetBaseValue`，又没经过 ASC 或 `FGameplayAttribute::SetNumericValueChecked` 这类正规入口，`Pre/PostGameplayEffectExecute` 不会被叫到，相当于绕开了 GE 管线；`Pre/PostAttributeChange` 也可能和你想象的不一样。
2. Duration / Infinite 的 GE 往往不会像 Instant 那样进 `Pre/PostGameplayEffectExecute`，因为Duration和Infinite的效果更多是通过 Modifier 挂到聚合器上再重算 Current，而不算是一次修改的执行，对数据进行了一次修改。可以想成是挂了一个状态到对应的ASC上面。
3. Current 被改时（走 GE 或上述正规路径），`Pre/PostAttributeChange` 一般会到。Base 被改时，`Pre/PostAttributeBaseChange` 被调用之后，`Pre/PostAttributeChange` 也常常会跟着被调用，因为 Current 通常由 Base 和 Modifier 推出来，当Base被修改时，Current值的锚点变了，Current值也相应的被修改了。

{% mermaid %}
flowchart TB
  subgraph OK["正规路径：GE / ASC / SetNumericValueChecked"]
    A[写入请求] --> B{语义类型}
    B -->|Instant / Execute 提交| E1[Pre/PostGameplayEffectExecute]
    B -->|改 Base| E2[Pre/PostAttributeBaseChange]
    E2 --> E3[常再触发 Pre/PostAttributeChange]
    B -->|聚合器重算 Current| E4[Pre/PostAttributeChange]
  end
  subgraph BAD["绕管线：直接 SetBase / SetCurrent"]
    X[裸写 float] --> Y[Pre/PostGameplayEffectExecute 通常不到]
    X --> Z[Pre/PostAttribute 行为可能与预期不符]
  end
{% endmermaid %}

*图 3：改数走框架与「手改裸值」时，回调大致会差在哪里（细节以 `AbilitySystemComponent` 调用栈为准）。*

#### 网络同步

`AttributeSet.cpp` 里的 `IsNameStableForNetworking` 写得很直白，如果需要进行网络同步，AttributeSet要满足：C++ 里建的默认子对象、从关卡包加载的放置 Actor 上的子对象、或者调过 `SetNetAddressable()` 的实例。反过来，运行时 `NewObject` 挂上却从没 `SetNetAddressable`，有可能复制怪、对不上号，排查时值得先看一下是不是这类情况。

相关接口在 `AttributeSet.h`：

```cpp
/** This signifies the attribute set can be ID'd by name over the network. */
UE_API void SetNetAddressable();
UE_API virtual void PreNetReceive() override;
UE_API virtual void PostNetReceive() override;
```

需要同步的属性，依旧是需要在 `FGameplayAttributeData` 配 `Replicate 的相关字段`，在 `GetLifetimeReplicatedProps` 里 `DOREPLIFETIME`，`OnRep_` 里用 `GAMEPLAYATTRIBUTE_REPNOTIFY` 等把复制下来的值喂回 ASC 内部的聚合状态。

`PreNetReceive` / `PostNetReceive` 做的是更底层的事：在 Actor 收网络属性更新的前后，用 `FScopedAggregatorOnDirtyBatch` 把聚合器的脏更新短暂锁住，保证这一小段窗口里，本地 Modifier 和正在写入的网络值不会搅在一起；这一轮收完再放开。

{% mermaid %}
sequenceDiagram
  participant Net as 网络复制
  participant Agg as ASC 聚合器
  participant AS as AttributeSet
  Net->>AS: PreNetReceive / BeginNetReceiveLock
  Note over Agg: 脏更新暂锁，避免与本地 Modifier 交织
  Net->>AS: 复制写入属性成员
  Net->>AS: PostNetReceive / EndNetReceiveLock
  Note over Agg: 本轮网络更新结束后再放开
{% endmermaid %}

*图 4：`PreNetReceive` / `PostNetReceive` 与聚合器批量锁的大致时序（对应 `FScopedAggregatorOnDirtyBatch`）。*

```c++
void FScopedAggregatorOnDirtyBatch::BeginNetReceiveLock()
{
	BeginLock();
}
void FScopedAggregatorOnDirtyBatch::EndNetReceiveLock()
{
	// The network lock must end the first time it is called.
	// Subsequent calls to EndNetReceiveLock() should not trigger a full EndLock, only the first one.
	if (GlobalBatchCount > 0)
	{
		GlobalBatchCount = 1;
		NetUpdateID++;
		GlobalFromNetworkUpdate = true;
		EndLock();
		GlobalFromNetworkUpdate = false;
	}
}
```

#### 聚合器（Aggregator）

前面 Duration / Infinite 已经多次提到聚合器：对每个 `FGameplayAttribute`，ASC 会维护 `FAggregator`，把当前生效的 GE Modifier 记录下来，求值时把 Base 和各条 Modifier 按照UE的既定顺序合成 Current。它相当于是这个属性在框架里的「运算中枢」，Buff 不是零散地修改最终的值，而是作为贡献之一挂在中枢上，由统一规则出结果。

`UAttributeSet` 留了一个跟聚合器生命周期有关的钩子：

```cpp
/** Callback for when an FAggregator is created for an attribute in this set. Allows custom setup of FAggregator::EvaluationMetaData */
virtual void OnAttributeAggregatorCreated(const FGameplayAttribute& Attribute, FAggregator* NewAggregator) const { }
```

某个属性第一次需要聚合器时，ASC 会建好 `FAggregator` 再回调这里。这里适合做的是一次性配置，比如给 `FAggregator::EvaluationMetaData` 挂上项目自己的求值上下文、曲线或调试信息。`FAggregator` 具体怎么算，还是要回到 ASC 和 GE 那一路去读。

---

## 一些使用经验

### Meta Attribute 与伤害管道

**Meta Attribute**：只当管道用、不参与网络复制。数值仅仅在 GE 执行链里走一遭，最后在 `PostGameplayEffectExecute` 或者其他阶段消费掉，转到真正的业务属性上后清零。伤害结算就是一个典型场景。

#### 声明：不复制、无 OnRep

以 [GASDocumentation](https://github.com/tranek/GASDocumentation) 里的 `UGDAttributeSetBase` 为例，`Damage` 被声明成 meta：

```cpp
// GDAttributeSetBase.h
// Damage is a meta attribute used by the DamageExecution to calculate final damage,
// which then turns into -Health. Temporary value that only exists on the Server. Not replicated.
UPROPERTY(BlueprintReadOnly, Category = "Damage")
FGameplayAttributeData Damage;
ATTRIBUTE_ACCESSORS(UGDAttributeSetBase, Damage)
```

这里没有 `ReplicatedUsing = OnRep_Damage`，`GetLifetimeReplicatedProps` 里也不复制 `Damage`，它只在服务器上一次 GE 执行的生命周期里存在，算完就清，客户端只要最终的 `Health` 等对账结果。

#### 流程：ExecutionCalculation 写入 → PostGameplayEffectExecute 转嫁

这个流程常见的套路是：

1. GE 挂上 `ExecutionCalculation`（如 `GDDamageExecCalculation`），在 `Execute_Implementation` 里从 Modifier 或 SetByCaller 拿原始伤害，再用 Target 的护甲等算出减免，最后用 `AddOutputModifier` 把减免后的数写到 Target 的 `Damage` 上。
2. 框架对 Target 的 `Damage` 做完这次修改后，会进 `PostGameplayEffectExecute`。
3. 在 `PostGameplayEffectExecute` 里判断 `Data.EvaluatedData.Attribute == GetDamageAttribute()`：读出 `GetDamage()` 当本次伤害，立刻 `SetDamage(0.f)` 清掉，再拿去扣 `Health`（或先盾后血这种特殊逻辑），顺便做 Clamp、受击表现、击杀结算等。

{% mermaid %}
flowchart LR
  subgraph Srv["Server（典型伤害管线）"]
    EC[ExecutionCalculation] -->|AddOutputModifier| Meta[Damage Meta  
不复制]
    Meta --> PGE[PostGameplayEffectExecute]
    PGE -->|SetDamage 0 后| HP[Health 等真实属性]
    PGE --> FX[Clamp / 盾 / 受击与击杀逻辑]
  end
  Cli[Client] -.复制对账.-> HP
{% endmermaid %}

*图 5：Meta `Damage` 作管道——Exec 写入，在 `PostGameplayEffectExecute` 转嫁到真实属性后清零；客户端通常只收 `Health` 等复制结果。*

GASDocumentation 里的片段（有删减）：

```cpp
// GDAttributeSetBase.cpp - PostGameplayEffectExecute 的 Damage 分支
if (Data.EvaluatedData.Attribute == GetDamageAttribute())
{
    const float LocalDamageDone = GetDamage();
    SetDamage(0.f);  // 用完即清

    if (LocalDamageDone > 0.0f)
    {
        const float NewHealth = GetHealth() - LocalDamageDone;
        SetHealth(FMath::Clamp(NewHealth, 0.0f, GetMaxHealth()));
        // ... 受击动画、伤害数字、击杀奖励等
    }
}
```

```cpp
// GDDamageExecCalculation.cpp - 写入 Damage Meta Attribute
float MitigatedDamage = UnmitigatedDamage * (100.f / (100.f + Armor));
if (MitigatedDamage > 0.f)
{
    OutExecutionOutput.AddOutputModifier(
        FGameplayModifierEvaluatedData(DamageStatics().DamageProperty, EGameplayModOp::Additive, MitigatedDamage));
}
```

Lyra 的 `LyraHealthSet` 同样有 `Damage`、`Healing` 一类 meta，`LyraDamageExecution` / `LyraHealExecution` 写数，`PostGameplayEffectExecute` 转嫁到 `Health` 并清零。读 Lyra 可以按同一套思路对照。

#### 为什么不直接在 Exec 里改 Health

你可能会奇怪，我直接在 ExecutionCalculation 里 `AddOutputModifier` 到 `Health` 也能扣血，有什么必要在项目里意绕一层 meta？我总结了下面几个好处：

- 护盾优先、Clamp、击杀判定这种通用的逻辑可以集中在 AttributeSet 里写一遍，不用散在各路 Exec 里，方便维护。
- 像「血量为 0 判胜负」这类规则，放在 `ExecutionCalculation` 里并不稳：那时属性还没走完提交，GE 可能被服务器拒掉、多来源改写也还在路上，所以拿到的属性值（比如护盾值）并不一定是上一次Execution执行之后的，而是一份脏数据，或者一份过时的快照。更稳妥的是等 `PostGameplayEffectExecute`，数值按管线落稳了再动游戏规则。
- 伤害来源、受击方向、HitResult 等上下文在 `PostGameplayEffectExecute` 里往往更好拿。
- Meta 不复制，服务器算完就丢，客户端只收最终的 `Health`，并不会对网络同步有什么额外的负担。

---

### 属性初始化：InitFromMetaDataTable 与 InitAttributeSetDefaults

填初值除了在代码中写死，一般还有常见两种方法进行初始化：DataTable，以及 CurveTable + `FAttributeSetInitter`。

#### InitFromMetaDataTable：按 DataTable 行填

`UAttributeSet::InitFromMetaDataTable` 在 `AttributeSet.cpp`（路径见文首），从 `FAttributeMetaData` 类型的 DataTable 里按行名填 Base 和 Current：

```cpp
// AttributeSet.cpp，InitFromMetaDataTable 核心逻辑（有删减；UE5 中 UProperty 已更名为 FProperty）
void UAttributeSet::InitFromMetaDataTable(const UDataTable* DataTable)
{
	static const FString Context = FString(TEXT("UAttribute::BindToMetaDataTable"));

	for( TFieldIterator<FProperty> It(GetClass(), EFieldIteratorFlags::IncludeSuper) ; It ; ++It )
	{
		FProperty* Property = *It;

		// Only process properties that can back gameplay attributes. They will be either FGameplayAttributeData 
		// or a floating-point numeric property (floats, doubles, potentially user custom).
		if (FGameplayAttribute::IsSupportedProperty(Property))
		{
			FString RowNameStr = FString::Printf(TEXT("%s.%s"), *Property->GetOwnerVariant().GetName(), *Property->GetName());
			if (FAttributeMetaData* MetaData = DataTable->FindRow<FAttributeMetaData>(FName(*RowNameStr), Context, false))
			{
				FNumericProperty* NumericProperty = CastField<FNumericProperty>(Property);
				if (NumericProperty)
				{
					// Passing FGameplayAttribute::IsSupportedProperty() as numeric property already implies it's floating point
					check(NumericProperty->IsFloatingPoint());
					void* Data = NumericProperty->ContainerPtrToValuePtr<void>(this);
					NumericProperty->SetFloatingPointPropertyValue(Data, MetaData->BaseValue);
				}
				else if (FGameplayAttribute::IsGameplayAttributeDataProperty(Property))
				{
					FStructProperty* StructProperty = CastField<FStructProperty>(Property);
					check(StructProperty);
					FGameplayAttributeData* DataPtr = StructProperty->ContainerPtrToValuePtr<FGameplayAttributeData>(this);
					check(DataPtr);
					DataPtr->SetBaseValue(MetaData->BaseValue);
					DataPtr->SetCurrentValue(MetaData->BaseValue);
				}
			}
			
		}
	}

	PrintDebug();
}
```

`FAttributeMetaData` 继承 `FTableRowBase`，常见字段有 `BaseValue`、`MinValue`、`MaxValue` 等（以引擎 `AttributeSet.h` 为准）。行名要符合 `AttributeSet类名.属性名`这种格式，C++ 类去掉 `U` 前缀，Blueprint 类去掉 `_C` 后缀。

#### InitAttributeSetDefaults：CurveTable + 按等级初始化

要按等级给不同角色配初值时，会用 `FAttributeSetInitterDiscreteLevels`（或项目自己的 Initter）。它从 CurveTable 预加载数据，在角色生成、升级等时机调用 `InitAttributeSetDefaults`：

```cpp
// AttributeSet.cpp，FAttributeSetInitterDiscreteLevels::InitAttributeSetDefaults 核心逻辑
void FAttributeSetInitterDiscreteLevels::InitAttributeSetDefaults(
    UAbilitySystemComponent* AbilitySystemComponent, FName GroupName, int32 Level, bool bInitialInit) const
{
  // .... 省略部分前面的逻辑
  const FAttributeSetDefaults& SetDefaults = Collection->LevelData[Level - 1];
    for (const UAttributeSet* Set : AbilitySystemComponent->GetSpawnedAttributes())
    {
      if (!Set)
      {
        continue;
      }
      const FAttributeDefaultValueList* DefaultDataList = SetDefaults.DataMap.Find(Set->GetClass());
      if (DefaultDataList)
      {
        ABILITY_LOG(Log, TEXT("Initializing Set %s"), *Set->GetName());

        for (auto& DataPair : DefaultDataList->List)
        {
          check(DataPair.Property);

          if (Set->ShouldInitProperty(bInitialInit, DataPair.Property))
          {
            FGameplayAttribute AttributeToModify(DataPair.Property);
            AbilitySystemComponent->SetNumericAttributeBase(AttributeToModify, DataPair.Value);
          }
        }
      }		
    }
    
    AbilitySystemComponent->ForceReplication();
}
```

CurveTable 行名常见格式是 `ClassName.SetName.AttributeName`（例如 `Default.UGDAttributeSetBase.Health`），`PreloadAttributeSetData` 会解析并生成按等级索引的默认值表。ASC 的 `InitStats`、`DefaultStartingData` 等会通过全局的 `FAttributeSetInitter`（如 `UAbilitySystemGlobals::GlobalAttributeSetInitter`）间接走到这里。

所以总结下来就是：`InitFromMetaDataTable` 适合「一张表一套初值」；`InitAttributeSetDefaults` 适合「Group + Level 多套表」。两者最终都会通过 `SetNumericAttributeBase` 或直接写 `FGameplayAttributeData` 把初值接进聚合器和复制管线。

{% mermaid %}
flowchart TB
  subgraph DT["DataTable：一张表一套初值"]
    R1["行名 ClassName.PropertyName"] --> I1[InitFromMetaDataTable]
    I1 --> W1[写 Base / Current 初值]
  end
  subgraph CT["CurveTable + Initter：按 Group / Level"]
    R2["Curve 行解析为等级表"] --> I2[InitAttributeSetDefaults]
    I2 --> W2[SetNumericAttributeBase]
    I2 --> FR[ForceReplication]
  end
  W1 --> Out[接入聚合器与复制管线]
  W2 --> Out
  FR --> Out
{% endmermaid %}

*图 6：两种常见初值入口最终都接到 ASC 的数值与复制管线。*


## 阅读源码的建议顺序

1. 打开 `AttributeSet.h`，把 `UAttributeSet` 的虚函数列表过一遍，心里有个「有哪些钩子」的清单。
2. 在 `AbilitySystemComponent.cpp` 里搜 `PreAttributeChange`、`PostAttributeChange`、`PreAttributeBaseChange`，看调用栈上游是 Effect 还是别的路径。
3. 起一个最小的 `UAttributeSet` 子类，打日志看 Base / Current 在 Instant、Duration、Infinite 三种 Effect 下怎么动。

---

## 小结

总结以下本篇的内容：

- **架构与改数入口**：AttributeSet 挂在 ASC 下；外面改数尽量走聚合器，别手改字段。`Pre/PostGameplayEffectExecute`、`Pre/PostAttributeChange`、`Pre/PostAttributeBaseChange` 各自在什么路径下会叫到，正文「属性修改时会叫到谁」里有一张对照图。
- **Base / Current**：`FGameplayAttributeData` 里一个是叠算锚点、一个是当前参与运算的值，和 Instant 与 Duration/Infinite 的语义绑定。
- **句柄与宏**：`FGameplayAttribute` 走反射、和 GE 解耦；`ATTRIBUTE_ACCESSORS` 把成员和静态 `GetXXXAttribute()` 绑在一起；运行时补挂子集可以走 `GetOrCreateAttributeSubobject`。
- **复制与聚合器锁**：要参与复制，子对象路径得稳（默认子对象 / 放置实例 / `SetNetAddressable` 等）；`PreNetReceive` / `PostNetReceive` 配合 `FScopedAggregatorOnDirtyBatch`，在收网络属性的一小段窗口里锁住聚合器，避免和本地 Modifier 搅在一起。聚合器本身是每个属性上的「运算中枢」，`OnAttributeAggregatorCreated` 可做一次性配置。
- **Meta Attribute**：如 `Damage` 只当管道、不复制；ExecutionCalculation 写入，`PostGameplayEffectExecute` 里转嫁到真实属性后清零，伤害管线里很常见。
- **初值**：`InitFromMetaDataTable`（DataTable 行名对齐属性）和 `InitAttributeSetDefaults`（CurveTable + Level），最后都通过 `SetNumericAttributeBase` 等路径接进聚合器和复制管线。


---

## 收尾

好了，以上就是 AttributeSet 的内容了，单看代码量不大，逻辑也不难，但是这却是GAS的基石之一，它在 Effect → ASC → 复制这条链的中间有着非常重大的影响。

希望这篇内容能给你一些启发，下一篇的内容可能会是GE或者ASC相关，我们不见不散。