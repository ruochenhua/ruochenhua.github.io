---
title: UE中的变体
date: 2025-11-30 21:15:48
categories: 
	- 技术漫谈
tags: [UE5, C++, Variant]
index_img: /2025/11/30/UE中的变体/variant_index.svg
banner_img: /2025/11/30/UE中的变体/variant_banner.svg
---

# 前言
最近在工作中，为了实现数据在多个关卡间的传递与管理，我在一个 `GameInstanceSubsystem` 中实现了如下方法：

```cpp
UCLASS()
class UDataManageSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()
public:
    UFUNCTION()
    void SetSharedData(const FName& Key, UObject* InData);
    UFUNCTION()
    bool GetSharedData(const FName& Key, UObject* OutData);
    
private:
    UPROPERTY()
    TMap<FName, UObject*> SharedDataMap;
};
```

可以看到，我在Subsystem中创建了一个`FName`到`UObject*`的映射表，同时暴露了`GetSharedData`和`SetSharedData`两个接口。也就是说，这个Subsystem可以存储和管理任意`UObject`类型的数据。

这种方法实现简单，但使用起来颇为不便，因为大多数情况下我想要保存的数据都是简单类型，比如`int`、`float`、`FString`等。使用这种方法时，我不得不创建一个`UObject`来包装这些简单类型的数据。

或许你会想到使用模板方法，根据数据类型创建不同的`SharedDataMap`，如下所示：

```cpp
UCLASS()
class UDataManageSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()
public:
    template <typename T>
    void SetSharedData(const FName& Key, T& Data);
    template <typename T>
    T GetSharedData(const FName& Key);
    
private:
    TMap<FName, int> SharedIntDataMap;
    TMap<FName, float> SharedFloatDataMap;
    TMap<FName, FString> SharedStringDataMap;
};
```

这确实是一种思路，但这种实现方式存在明显问题：每新增一种需要存储的数据类型，我就需要创建一个新的Map来维护该类型的数据，导致Get和Set函数变得冗长复杂。尤其是在需要存储多种自定义`FStruct`等复合类型时，类型数量将难以控制在合理范围内。

# 变体
C++17标准库引入了`std::variant`通用变体类型，其核心价值在于能在单一变量中安全地存储和切换多种不同类型的值，同时避免了类型不安全的裸指针或union的缺陷。UE也引入了自己的variant类型，用于满足引擎中存储和切换不同类型值的需求，其中包括`TVariant`和`FVariant`。

## TVariant
`TVariant`是UE核心容器模块提供的模板驱动型轻量级变体（定义在`Containers/Variant.h`），本质是**类型安全的增强版union**，专为底层高性能场景设计。

在UE中，`TVariant`更接近`std::variant`的实现，它不依赖UE的反射系统，需要在编译时指定所有可能的类型列表。例如：

```cpp
TVariant<int, float, FString> MyVariant;
```

这种设计的优势在于，`TVariant`会按照最大类型尺寸+1字节的大小在栈上分配固定内存空间，这样就能以近乎原生的速度访问数据，且不存在反射和垃圾回收(GC)的开销。

如果使用`TVariant`，前面的代码可以优化为：

```cpp
#include "Containers/Variant.h"

// 自定义FStruct示例
USTRUCT()
struct FMyCustomStruct
{
    GENERATED_BODY()
    int32 ID = 0;
    FString Name = TEXT("");
};

UCLASS()
class UDataManageSubsystem_TVariant : public UGameInstanceSubsystem
{
    GENERATED_BODY()
public:
    template<typename T>
    void SetSharedData(const FName& Key, const T& InData);

    template<typename T>
    bool GetSharedData(const FName& Key, T& OutData);

private:
    // 支持的类型列表：int32/float/FString/FMyCustomStruct
    using DataVariant = TVariant<int32, float, FString, FMyCustomStruct>;
    TMap<FName, DataVariant> SharedDataMap;
};

template<typename T>
void UDataManageSubsystem_TVariant::SetSharedData(const FName& Key, const T& InData)
{
    DataVariant VariantData;
    VariantData.SetValue<T>(InData); // 直接通过T设置值（TVariant会自动匹配类型）
    SharedDataMap.Emplace(Key, VariantData); // 使用Emplace确保覆盖已有键值
}

template<typename T>
bool UDataManageSubsystem_TVariant::GetSharedData(const FName& Key, T& OutData)
{
    const auto* VariantPtr = SharedDataMap.Find(Key);
    if (!VariantPtr) return false;

    // 仅用运行时IsType<T>()判断
    if (VariantPtr->IsType<T>())
    {
        OutData = VariantPtr->GetValue<T>();
        return true;
    }
    return false;
}
```

这里我们自定义了一个结构体`FMyCustomStruct`，并使用`using`关键字定义了一个变体类型别名：

```cpp
using DataVariant = TVariant<int32, float, FString, FMyCustomStruct>;
```

这样，我们就能在模板函数中，利用`TVariant`提供的`IsType<T>`、`GetValue<T>`和`SetValue<T>`方法，在`SharedDataMap`中统一管理这四种类型的数据。

### TVariant的访问者模式

除了通过`IsType<T>()`和`GetValue<T>()`进行类型检查和访问外，`TVariant`还支持访问者模式（Visitor Pattern），这是一种更安全、更优雅的访问方式。访问者模式通过`Visit`方法实现，可以避免手动类型检查的繁琐，同时保证类型安全。

```cpp
// 访问者模式示例
DataVariant MyVariant;
MyVariant.SetValue<int32>(42);

// 定义访问者函数
MyVariant.Visit([](auto&& Value) {
    using T = std::decay_t<decltype(Value)>;
    if constexpr (std::is_same_v<T, int32>)
    {
        UE_LOG(LogTemp, Log, TEXT("int32 value: %d"), Value);
    }
    else if constexpr (std::is_same_v<T, float>)
    {
        UE_LOG(LogTemp, Log, TEXT("float value: %f"), Value);
    }
    else if constexpr (std::is_same_v<T, FString>)
    {
        UE_LOG(LogTemp, Log, TEXT("FString value: %s"), *Value);
    }
    else if constexpr (std::is_same_v<T, FMyCustomStruct>)
    {
        UE_LOG(LogTemp, Log, TEXT("FMyCustomStruct: ID=%d, Name=%s"), Value.ID, *Value.Name);
    }
});
```

访问者模式的优势在于：
1. 编译时保证所有可能的类型都被处理
2. 避免运行时类型检查的开销
3. 代码结构更清晰，易于维护

### TVariant与std::variant的对比

`TVariant`与C++17标准库的`std::variant`在设计理念上非常相似，但也存在一些差异：

| 特性 | TVariant | std::variant |
|------|----------|--------------|
| 类型安全 | 是 | 是 |
| 栈上存储 | 是 | 是 |
| 访问者模式 | 支持 | 支持 |
| 索引访问 | 支持 | 支持 |
| 空状态 | 不支持（必须包含一个有效值） | 不支持 |
| UE特性集成 | 与UE类型（如FString、FName）完美兼容 | 需要额外适配 |
| 编译期优化 | 支持if constexpr优化 | 支持if constexpr优化 |
| 异常处理 | 使用checkNoEntry等UE断言机制 | 抛出std::bad_variant_access异常 |

在UE项目中，推荐使用`TVariant`而不是`std::variant`，因为`TVariant`与UE的类型系统和断言机制更好地集成，使用起来更方便。

### 使用constexpr优化
如前所述，`TVariant`是一个轻量级模板变体，性能开销极低。但在执行`VariantPtr->IsType<T>()`时，本质上仍是一次运行时类型判定。在编译阶段，所有与T相关的类型判断代码都会被生成，尽管大部分分支在运行时不会被执行。

具体而言，在上述例子中，即使代码实际上只使用了`DataVariant`的`int32`类型，`float`、`FString`和`FMyCustomStruct`的判定分支也会在编译时被生成。

当`TVariant`包含的类型数量不多且对编译后体积不敏感时，这种实现方式不会带来明显问题。但如果对包体大小有严格要求，且`TVariant`包含的类型数量众多，这种实现方式显然不是最优选择。

此时，我们可以使用`constexpr`进行优化，优化后的代码如下：

```cpp
// ------------------------------
// 带constexpr优化的实现
// ------------------------------
template<typename T>
void UDataManageSubsystem_TVariant::SetSharedData(const FName& Key, const T& InData)
{
    DataVariant VariantData;

    // 编译期分流：只生成当前T对应的代码
    if constexpr (std::is_same_v<T, int32>)
        VariantData.SetValue<int32>(InData);
    else if constexpr (std::is_same_v<T, float>)
        VariantData.SetValue<float>(InData);
    else if constexpr (std::is_same_v<T, FString>)
        VariantData.SetValue<FString>(InData);
    else if constexpr (std::is_same_v<T, FMyCustomStruct>)
        VariantData.SetValue<FMyCustomStruct>(InData);
    else
        checkNoEntry() << "Unsupported type!";

    SharedDataMap.Emplace(Key, VariantData); // 保持与前面示例一致，使用Emplace确保覆盖已有键值
}

template<typename T>
bool UDataManageSubsystem_TVariant::GetSharedData(const FName& Key, T& OutData)
{
    const auto* VariantPtr = SharedDataMap.Find(Key);
    if (!VariantPtr) return false;

    // 编译期确定T类型，只保留对应分支的运行时检查
    if constexpr (std::is_same_v<T, int32>)
        return VariantPtr->IsType<int32>() ? (OutData = VariantPtr->GetValue<int32>(), true) : false;
    else if constexpr (std::is_same_v<T, float>)
        return VariantPtr->IsType<float>() ? (OutData = VariantPtr->GetValue<float>(), true) : false;
    else if constexpr (std::is_same_v<T, FString>)
        return VariantPtr->IsType<FString>() ? (OutData = VariantPtr->GetValue<FString>(), true) : false;
    else if constexpr (std::is_same_v<T, FMyCustomStruct>)
        return VariantPtr->IsType<FMyCustomStruct>() ? (OutData = VariantPtr->GetValue<FMyCustomStruct>(), true) : false;
    else
        return false;
}
```

与前面相同的内容不再赘述，这里主要介绍`SetSharedData`和`GetSharedData`函数的优化点。

可以看到，这两个函数中添加了多个`if constexpr`条件判断。`if constexpr`是C++17引入的编译期分支特性，其条件表达式必须是能在编译期确定真假的常量表达式。编译器会根据条件真假直接消除不成立的分支，不生成对应代码。

若条件不是编译期常量，`if constexpr`会退化为普通的`if`，失去编译期分支消除的优化效果，甚至可能引发编译错误。

因此，这里的多个`if constexpr`判断会在编译时就优化掉无效分支，使得编译后的包体只包含实际可能执行的分支代码，从而显著减小包体体积。

当然，若对包体大小不敏感，则无需进行此优化。该优化对运行时性能的提升微乎其微，其主要价值在于优化编译后包体大小，以及在编译期暴露潜在错误以提升代码安全性。

## FVariant
顺便一提，在我最初研究UE中的变体类型时，曾咨询过AI助手。得到的答复是：`TVariant`是轻量级变体模板，而`FVariant`是支持蓝图和UE反射系统的高级变体类型。

起初我信以为真，但深入研究后发现事实并非如此。`FVariant`的资料非常稀少，从Epic官方论坛的信息来看，它应该是一个很早就存在的类型，其历史远早于`TVariant`。实际上它既不支持反射系统，也不支持蓝图，仅能在C++代码中使用。给人的感觉像是从boost variant演变而来，可能在variant正式纳入C++标准之前就已存在于UE中。

在代码中使用`FVariant`的方式与`TVariant`类似，主要区别在于：

1. `FVariant`不需要提前声明包含的类型列表，而`TVariant`需要
2. `FVariant`没有`SetValue`方法，而是通过构造函数直接赋值
3. `FVariant`没有`IsType`类型判定方法，因此通过`GetValue<T>`获取值时，若类型不匹配，很可能会直接导致程序崩溃
   - `FVariant`提供了`GetType`方法，返回`EVariantType`枚举值。该枚举涵盖了各种基础类型，但所有自定义类型都只能用`CustomType`一个值来表示，这意味着无法区分不同的自定义`FStruct`类型，因此实用性有限
   - [EVariantTypes 文档](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Core/EVariantTypes)

下面是 UE 中 `FVariant` 的页面，可以作为参考，但是其他资料就很少了：[FVariant 文档](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Core/FVariant)

与`TVariant`相比，`FVariant`的唯一优势可能就是无需提前声明包含的类型，其他方面并无明显优势。再加上它确实是一个相对古老的类型，如果`FVariant`是UE更推荐使用的类型，就没必要再推出功能相似的`TVariant`了。因此，在新项目中，建议优先使用`TVariant`。

# 总结

本文介绍了UE中的两种变体类型：`TVariant`和`FVariant`，重点讲解了`TVariant`的用法和优化技巧：

1. `TVariant`是UE核心容器模块提供的类型安全的增强版union，专为高性能场景设计
2. 使用`TVariant`可以在单一变量中安全地存储和切换多种不同类型的值
3. 可以通过`IsType<T>()`和`GetValue<T>()`进行类型检查和访问
4. 支持访问者模式，提供更安全、更优雅的访问方式
5. 可以使用`if constexpr`进行编译期优化，减小包体体积
6. `TVariant`与C++17标准库的`std::variant`类似，但与UE类型系统更好地集成
7. `FVariant`是一个相对古老的类型，功能有限，建议在新项目中优先使用`TVariant`

通过合理使用`TVariant`，可以简化代码结构，提高代码的可维护性和性能，是UE开发中处理多类型数据的得力工具。