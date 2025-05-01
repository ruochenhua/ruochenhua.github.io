---
title: OpenGL优化技巧之DSA
date: 2025-02-22 17:47:06
categories: 
	- 技术漫谈
tags: [OpenGL, 编程, 优化]

index_img: /2025/02/22/opengl-dsa/OpenGL-logo.jpg
banner_img: /2025/02/22/opengl-dsa/OpenGL-banner.png
---

## 前言
最近工作依旧是处于比较繁忙的阶段，由于我突然被委以一项不大不小但是进度十分紧急的任务，导致我每天所能挤出来更新的时间是越来越少了。[KongEngine](https://github.com/ruochenhua/KongEngine)的重构有所进展，现在已经将最基础的模型渲染抽象了出来，并且实现了Vulkan渲染的一个简单流程，但是离最终目标还有一定距离。

以前的一些坑（IBL、SSAO）也没有什么精力来填了，这篇文章打算“水”一期，讲讲一个关于OpenGL优化的非常小的一个方面，Direct State Acess（DSA）。

为了聊明白Direct State Acess（以下简称DSA）是什么，以及为什么它可以作为一种优化OpenGL的方法，我们首先需要理解一个概念，即：OpenGL本质上是一个状态机。

## OpenGL本质上是一个状态机
该如何理解这句话呢？我们来思考一下，状态机最核心的组成部分是各个不同的状态，以及状态之间的逻辑转换，对于到OpenGL可以做以下的理解：

- 状态：**OpenGL有大量可配置的状态**。例如，绘图模式（点、线、三角形等）、光照模型（是否启用光照、光源位置和属性等）、纹理参数（纹理过滤方式、纹理坐标模式等）、当前绑定的帧缓存以及各种测试和混合函数的设置等。这些状态决定了 OpenGL 如何处理和渲染图形数据。**一旦状态被设置，它们就会影响后续OpenGL命令的执行结果**。比如设置了当前绑定的帧缓存，后面的操作就会在指定的缓存上生效，直到解绑或者绑定另外的缓存。

- 状态之间的装换：**OpenGL 就像一个具有不同状态的机器，用户通过调用 OpenGL 的函数来切换状态和执行操作**。例如，通过调用函数可以从一种绘图模式切换到另一种绘图模式，或者启用不同的着色器。每个状态下可以执行相应的操作，并且操作的结果取决于当前所处的状态。**OpenGL 命令不是孤立执行的，而是基于当前的状态来执行**。例如，当执行绘制三角形的命令时，它会根据当前的绘图模式、颜色状态、纹理状态等，来确定如何绘制这个三角形。

这些概念可能看着有点抽象，可以通过下面的示例代码来理解：

```c++

auto mesh_shader = water_comp->shader_data;

mesh_shader->Use();
glActiveTexture(GL_TEXTURE0);
glBindTexture(GL_TEXTURE_2D, water_render_helper_.water_reflection_texture);
glActiveTexture(GL_TEXTURE1);
glBindTexture(GL_TEXTURE_2D, water_render_helper_.water_refraction_texture);

mesh_shader->SetMat4("model", water_actor->GetModelMatrix());
mesh_shader->SetFloat("move_factor", fmodf(water_render_helper_.total_move*water_render_helper_.move_speed, 1.0));

water_comp->Draw(scene_render_info);

```
这段代码非常简单，首先获取一个将要使用的shader：**mesh_shader**。将其设定为使用后，激活他的两个纹理通道，将两张纹理分别绑定到对应的位置上。然后设置一些shader将要使用的参数的值，最后渲染。

这里面**mesh_shader->Use()**就是一次状态的转换，将OpenGL从其他状态转换到了mesh_shader对应的状态上。后面的代码是基于OpenGL处于mesh_shader下的状态而来的，这两张纹理以及后面的参数是要作为mesh_shader的输入，而不是其他的shader。以及最后的**Draw**函数更是基于当前处于mesh_shader下的状态。

另外值得注意的是，**glActiveTexture**以及**glBindTexture**这两个函数的调用也可以视为一个状态的转换。从状态机的角度来看，OpenGL 维护着一个当前激活纹理单元的状态。**调用 glActiveTexture 函数会改变这个状态，将当前激活的纹理单元从一个切换到另一个**，而**当调用 glBindTexture 函数时，会改变当前激活纹理单元所绑定的纹理对象**。

OpenGL的原本设计中，状态切换是很频繁的，在图形技术和方法发展的越来越快的时候，这带来了不少的问题。

## 状态切换的缺点
在现在发展的越来越复杂、步骤越来越长的图形算法的影响下，一次渲染可能需要非常多次的OpenGL中的状态切换。

比如KongEngine也实现了的延迟渲染，它需要先将部分信息渲染到帧缓存上，分别放置于不同的几张纹理之中，然后利用这些纹理再做一次渲染得到结果。而这个结果可能要再次经过几个不同的后处理才能最终在屏幕上呈现。这个渲染流程很长很复杂，其中涉及到的状态切换非常多。

而状态切换这个操作是有一定的性能损耗的：
 - 硬件寄存器的修改损耗：每次状态变化都需要GPU修改其内部的硬件寄存器。这些寄存器存储了当前渲染所需的参数，如深度测试、混合模式等。**频繁的状态切换导致GPU不断重新配置这些寄存器，增加了硬件的处理负担**。

 - 驱动程序的处理消耗：状态变化需要通过驱动程序进行处理。**驱动程序将这些变化转换为GPU可以执行的命令传输到GPU。这一过程消耗了CPU资源和总线带宽**，尤其是在频繁切换的情况下，性能损失更为明显。

 - CPU和GPU的同步损耗：状态切换通常需要CPU和GPU之间的同步操作。**频繁的状态变化导致更多的同步开销，增加了CPU的负载，同时也可能造成GPU的等待时间**，进而降低了整体渲染效率。

 - GPU渲染管线的重构损耗：OpenGL的渲染管线包括多个阶段，如顶点处理、光栅化和着色器执行。**状态变化可能导致管线的某些部分需要重新初始化**，例如切换着色器时需要重新编译和加载新的程序。这会引入额外的延迟，尤其是在需要频繁切换渲染状态时。

所以在图形算法流程复杂度不变的情况下，减少OpenGL状态切换能够帮助性能提升，这正是DSA的主要作用。

## 直接状态访问
DSA，直接状态访问，是用来解决OpenGL状态切换引起的性能损耗的方法之一。它是OpenGL 4.5引入的一个重要特性，它允许开发者直接访问和修改 OpenGL 对象的状态，而不需要将这些对象绑定到全局状态机上。

我们同样是以上面那个代码来举例：

```c++
auto mesh_shader = water_comp->shader_data;

mesh_shader->Use();

glBindTextureUnit(0, water_render_helper_.water_reflection_texture);
glBindTextureUnit(1, water_render_helper_.water_refraction_texture);

mesh_shader->SetMat4("model", water_actor->GetModelMatrix());
mesh_shader->SetFloat("move_factor",fmodf(water_render_helper_.total_move*water_render_helper_.move_speed, 1.0));

water_comp->Draw(scene_render_info);
```

和之前的代码对比可以看到，glActiveTexture和glBindTexture这两个函数被替换成了**glBindTextureUnit**，这个函数可以不需要OpenGL进行状态的转换，而是直接将纹理资源对应到shader指定的输入上。

和glBindTextureUnit类似的方法还有很多：

### 缓存对象操作
不使用DSA：
```c++
// 生成缓冲区对象
GLuint VBO;
glGenBuffers(1, &VBO);

// 绑定缓冲区对象
glBindBuffer(GL_ARRAY_BUFFER, VBO);

// 设置缓冲区数据
glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices, GL_STATIC_DRAW);

// 解绑缓冲区对象
glBindBuffer(GL_ARRAY_BUFFER, 0);
```

使用DSA：
```c++
// 生成缓冲区对象
GLuint VBO;
glCreateBuffers(1, &VBO);

// 直接设置缓冲区数据
glNamedBufferData(VBO, sizeof(vertices), vertices, GL_STATIC_DRAW);
```

使用DSA后，创建VBO后的绑定和解绑步骤可以省略。

### 纹理对象操作
不使用DSA：
```c++
// 生成纹理对象
GLuint textureID;
glGenTextures(1, &textureID);

// 绑定纹理对象
glBindTexture(GL_TEXTURE_2D, textureID);

// 设置纹理参数
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);

// 解绑纹理对象
glBindTexture(GL_TEXTURE_2D, 0);
```

使用DSA：
```c++
// 生成纹理对象
GLuint textureID;
glCreateTextures(GL_TEXTURE_2D, 1, &textureID);

// 直接设置纹理参数
glTextureParameteri(textureID, GL_TEXTURE_WRAP_S, GL_REPEAT);
glTextureParameteri(textureID, GL_TEXTURE_WRAP_T, GL_REPEAT);
glTextureParameteri(textureID, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
glTextureParameteri(textureID, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
```

使用DSA后，纹理生成对象生成后可以直接设置他的参数，不需要绑定和解绑

### 帧缓冲对象
不使用DSA：
```c++
// 生成帧缓冲对象
GLuint FBO;
glGenFramebuffers(1, &FBO);

// 绑定帧缓冲对象
glBindFramebuffer(GL_FRAMEBUFFER, FBO);

// 附加纹理到帧缓冲
GLuint texture;
// 假设 texture 已经正确创建和设置
glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);

// 解绑帧缓冲对象
glBindFramebuffer(GL_FRAMEBUFFER, 0);
```

使用DSA：
```c++
// 生成帧缓冲对象
GLuint FBO;
glCreateFramebuffers(1, &FBO);

// 附加纹理到帧缓冲
GLuint texture;
// 假设 texture 已经正确创建和设置
glNamedFramebufferTexture(FBO, GL_COLOR_ATTACHMENT0, texture, 0);
```
使用DSA后，创建帧缓存后对其进行设置的时候，可以不需要绑定和解绑操作。

当然以上只是几个DSA的用法，除此之外还有很多，可以参考[官方wiki](https://www.khronos.org/opengl/wiki/Direct_State_Access)上的介绍来进一步了解。


## 结语
综上所述，深入了解 OpenGL 状态机有助于我们把握图形渲染的底层逻辑，而 DSA 则为解决传统状态切换带来的性能问题提供了有效途径。虽然在实际使用中，DSA 的优化效果可能因各种因素而异，但它在减少状态切换开销、提高代码可读性和可维护性等方面的优势不容忽视。
对于开发者而言，应根据具体的应用场景和硬件环境，合理运用 DSA 进行优化。通过不断地实践和总结，我们能够更好地发挥 OpenGL 的性能，为用户带来更加优质的图形体验。