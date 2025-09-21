---
title: 虚幻引擎ScriptStruct简介
date: 2025-09-21 14:20:40
categories: 
	- 技术漫谈
tags: [虚幻引擎, 工具]
index_img: /2025/09/21/虚幻引擎ScriptStruct简介/ue-scriptstruct-icon.png
banner_img: /2025/09/21/虚幻引擎ScriptStruct简介/ue-scriptstruct-banner.png 
---

# 前言
有两个月没有更新了，最近全身心投入在新的项目上，取得了不小的阶段性进展。周末台风天，在家里宅了两天，想想也该更新一下了。

今天就不分享什么很深的知识点了，而是计划分享一个我前两天在工作上用到的内容中的一个小知识点——虚幻引擎中的**ScriptStruct**。

# 从一个加塞需求开始讲起
这周三的时候，我正在按照原定的工作安排，不紧不慢的完成游戏中的一个系统的功能开发。下午的时候突然PM和制作人和我商量，有一个需求希望我在这周内完成——一个将策划的CSV表转换为UE中的DataTable的功能。

这个功能听起来似乎都不需要进行开发，因为UE引擎中已经提供了一个CSV导入工具，我们只需要将CSV文件导入到UE中，就可以将其转换为DataTable。不过这个需求的难点在于：
- 现在策划的表有很多，每个表的字段和结构都不一样，希望能有一个一键导入的功能。
- 我们现在游戏中用到的数据结构和表结构都还没有定，很有可能游戏中的数据结构会在未来的开发中发生变化，但是现在不能动，因此在导入的时候会需要做一些额外的数据处理。

给我的时间是截止到周五完成，我盘算了下，周四收尾手上的需求并进行规划，周五开发，时间紧巴巴，但也勉强能够实现。

# ScriptStruct
到周五的时候，我开始对这个需求进行开发，很自然的我在UE中创建了一个EditorUtilityWidget作为策划的编辑器工具界面，加了些按钮，加了选中CSV文件的功能。接下来就是计划如何实现CSV文件导入的工作了。

该如何实现将CSV的数据灵活的映射到不同结构的DataTable中呢，我想来想去，后来想到了UE中反射系统中的一个结构，**ScriptStruct**。

## 什么是ScriptStruct
UScriptStruct是UE反射系统的重要组成部分，它本质上是USTRUCT结构体的 "元数据容器"。
当我们在C++中用USTRUCT()宏定义一个结构体时，**UE的反射系统会自动为其生成一个对应的UScriptStruct实例。**这个实例存储了该结构体的所有元信息，包括：
 - 结构体的名称、大小和对齐方式
 - 包含的所有属性（成员变量）及其类型
 - 属性的各种标记（如编辑性、可见性等）
 - 结构体的构造和析构方法

简单来说，UScriptStruct就像是结构体的 "身份证"和"操作手册"，让引擎在运行时能够了解结构体的详细信息并对其进行操作。

在我们的CSV转DataTable需求中，我们可以利用UScriptStruct代表DataTable的行结构定义，它告诉我们每一行应该包含哪些字段，每个字段是什么类型。有了这个数据，我们就可以自动构建对应结构的DataTable资源了。


## 如何ScriptStruct的使用案例
Talk is cheap, show me the code. 好了，接下来我用一个例子来简单讲下ScriptStruct的使用。

在UE中，我定义一个数据表格行结构：
```cpp
USTRUCT(BlueprintType)
struct FMyStruct : TableRowBase
{
    GENERATED_BODY()

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    FString Name;

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    int32 Age;
};
```
这个结构包含了两个属性：Name和Age。每个属性都有一个对应的UScriptStruct实例，用于存储该属性的元信息。

## 如何获取ScriptStruct
在UE中，我们可以通过以下多种方式获取一个结构体的UScriptStruct实例，但首先，我们需要在我们的build.cs文件中引入下面两个模块：
```csharp
if (Target.Type == TargetType.Editor) {
    PrivateDependencyModuleNames.AddRange(new string[] { "UnrealEd", "AssetRegistry" });
}
```
其中，"UnrealEd"是UE编辑器模块的名称，"AssetRegistry"是资产注册模块的名称。

### 通过C++结构体直接获取
这个是最简单的方法，示例代码如下：
```cpp
// 1. 通过 StaticStruct() 直接获取（编译期确定，无性能损耗）
UScriptStruct* MyStruct = FMyStruct::StaticStruct();
// 2. 通过 TBaseStructure 模板获取（泛型场景适用）
cScriptStruct* GenericStruct = TBaseStructure<FMyStruct>::Get();
```


### 通过结构体名称动态查找
这个是我的导表工具所用的方法，我需要根据策划配置的表名来动态获取对应的ScriptStruct实例。

```cpp
#include "UObject/FindObject.h"
UScriptStruct* FindStructByName(const FName& StructName) {
    // 直接查找（优先推荐，性能好）
    UScriptStruct* Struct = FindObject<UScriptStruct>(GetTransientPackage(), *StructName.ToString());

    // 或者带模块路径的查找（避免同名冲突，如游戏模块 MyGame）
    if (!Struct) {
        FString FullPath = FString::Printf(TEXT("/Script/MyGame.%s"), *StructName.ToString());
        Struct = FindObject<UScriptStruct>(nullptr, *FullPath);
    }
    return Struct;
}
```

通过FindObject<>函数，我们可以根据结构体的名称动态查找对应的UScriptStruct实例。其中GetTransientPackage代表的是查找的package范围，在以前是可以用**ANY_PACKAGE**来表示所有的package，但是最新的UE版本是把这个给舍弃了。

另外需要注意的点是，**查找的StructName是不需要带F前缀的**。比如我们定义的FMyStruct，在查找的时候只需要传入"MyStruct"即可。可能ChatGPT或者游戏编程AI在生成代码的时候会加上前缀，这会导致找不到ScriptStruct，因为实际上结构的名称是不带F前缀的。

### 根据蓝图加载
如果我们的结构体是在蓝图中定义的，我们也可以通过蓝图的路径来获取对应的UScriptStruct实例。示例代码如下：
```cpp
#if WITH_EDITOR
#include "AssetRegistry/AssetRegistryModule.h"
UScriptStruct* LoadBpStruct(const FString& AssetPath) {
    FAssetRegistryModule& AssetReg = FModuleManager::LoadModuleChecked<FAssetRegistryModule>("AssetRegistry");
    TArray<FAssetData> Assets;
    AssetReg.Get().GetAssetsByPath(FName(*AssetPath), Assets, true);
    if (Assets.Num() > 0) {
        return Cast<UScriptStruct>(Assets[0].GetAsset());
    }
    return nullptr;
}
#endif
```
需要注意的是，蓝图资产必须加载（未加载时需通过 AssetRegistry 或 StaticLoadObject 强制加载），否则就会出现找不到的情况。

## ScriptStruct的应用
拿到了ScriptStruct实例，我们就可以根据它来进行数据的序列化、反序列化、反射等操作了。比如我们可以根据ScriptStruct来动态创建DataTable的行实例，或者根据ScriptStruct来获取结构体的属性信息等。


### 动态创建DataTable行实例
我们可以根据ScriptStruct来动态创建DataTable的资源
```cpp
 // 创建 DataTable
UDataTable* DataTable = NewObject<UDataTable>(Package, UDataTable::StaticClass(), *AssetName, RF_Public | RF_Standalone);
DataTable->RowStruct = RowStruct;   // RowStruct为对应的ScriptStruct实例
```

并且可以根据名称来获取对应的属性信息。

```cpp
FProperty* Prop = RowStruct->FindPropertyByName(FName(*Header));
```

根据这个属性信息，我们可以做不同的处理，比如如果是TArray类型的属性，我们可以创建一个TArray实例，然后将数据添加到这个数组中。如果是其他类型的属性，我们可以直接设置属性的值。

最后通过SavePackage方法将DataTable保存为UE资产，这个流程就是我导表工具的流：
```cpp
// 填充 SaveArgs 并调用 SavePackage（UE5 风格）
FSavePackageArgs SaveArgs;
SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
SaveArgs.bForceByteSwapping = false;
SaveArgs.bSlowTask = false;
SaveArgs.SaveFlags = SAVE_NoError;
SaveArgs.Error = GWarn;

bool bSaved = UPackage::SavePackage(Package, DataTable,  *PackageFileName, SaveArgs);
```


### 修改资产的属性
能创建，就能够修改资产的属性：
```cpp
// 1. 获取结构体的所有属性（含嵌套结构体）
TArray<FProperty*> AllProperties;
MyScriptStruct->GetProperties(AllProperties, EPropertyFlags::CPF_Persistent | EPropertyFlags::CPF_Edit);

// 2. 遍历属性并获取字段值（需传入结构体实例指针）
FMyStruct StructInstance; // 结构体实例
for (FProperty* Prop : AllProperties) {
    FString PropName = Prop->GetFName().ToString();
    FString PropValue = Prop->ExportTextItem(0, &StructInstance, nullptr, nullptr, 0);
    UE_LOG(LogTemp, Log, TEXT("字段 %s：%s"), *PropName, *PropValue);
}

``` 

需要注意的是，如果缓存了ScriptStruct数据，使用LiveCoding热重载后，需要重新获取ScriptStruct实例，否则会出现找不到属性的情况，变成了Stale Pointer，需要重新获取。

# 结语
好了，这就是对ScriptStruct的一个简单介绍，它不是什么很高深的技术，但是在作为UE的工具开发中还是相当重要的一环，尤其是涉及到资产的创建、删除和修改等等，都需要用到ScriptStruct。

希望这篇文章能够对大家有所帮助。

