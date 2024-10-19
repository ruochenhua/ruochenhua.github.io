---
title: 延迟渲染实现
date: 2024-10-19 17:18:41
categories: 
	- 技术漫谈
tags: [3D, render, 渲染, 编程]
index_img: /2024/10/19/defer-render/defer_render_banner.png
banner_img: /2024/10/19/defer-render/defer_render_banner.png
---


想要在Kong引擎里面实现的场景慢慢复杂了起来，光源和模型的数量从原先的十以内的数量增长到几十甚至几百的数量级，是时候接入延迟渲染的方法了。

# 延迟渲染


**延迟渲染**（Defer Rendering），或者**延迟着色法**（Defer Shading），是区别于**正向渲染**（Forward Shading）的一种计算场景光照的方式。

正向渲染方法就是遍历场景中的每一个模型，计算一个模型的光照表现后再继续下一个模型的计算，根据深度测试的结果更新屏幕上最终像素显示的颜色。这种方法是很容易让人理解并实现的。但是当场景中的光照和模型数量变多的时候，模型重叠的区域会进行不必要的光照计算（被挡住的模型像素区域最终会被前面的模型遮挡，但是这篇被挡住的区域还是被计算了光照），而光照计算一般来说是渲染消耗的大头，这部分时间就被浪费了。

而延迟渲染的想法则是将光照计算分成两部分。第一个部分叫做<strong>几何处理阶段</strong>（Geometry Pass），它先将光照计算所需要的模型信息（顶点位置、法线、颜色、材质属性等等）先渲染到多张贴图上（消耗低），经由深度检测保留最终在屏幕上显示的模型部分的这些信息。

<!-- wp:image {"sizeSlug":"large","align":"center"} -->
<figure class="wp-block-image aligncenter size-large"><img src="https://learnopengl-cn.github.io/img/05/08/deferred_g_buffer.png" alt=""/></figure>
<!-- /wp:image -->


第二部分叫做<strong>光照处理阶段</strong>（Lighting Pass），根据几何处理阶段保存的信息再去进行光照计算，这样就不会将算力浪费在计算被遮挡的模型部分的光照了，从而优化渲染的性能，也有赋予了能够更加方便的实现某些效果的能力（如SSAO）。

<!-- wp:image {"sizeSlug":"large","align":"center"} -->
<figure class="wp-block-image aligncenter size-large"><img src="https://learnopengl-cn.github.io/img/05/08/deferred_overview.png" alt=""/></figure>
<!-- /wp:image -->

# G缓冲
G缓冲(G-buffer)是对所有用来储存光照相关的数据，并在最后的光照处理阶段中使用的所有纹理的总称。它是我们计算最终渲染输出中的缓存和中转站，为了实现延迟渲染，G-buffer中会包含如下几张纹理的数据：模型顶点位置数据；模型法线数据；模型漫反射颜色数据；材质数据（ao，roughness，metallic）等等。有了这些数据则能够实现Kong引擎的PBR光照计算，初始化G-buffer的代码如下：

```c++
void DeferBuffer::GenerateDeferRenderTextures(int width, int height)
{
	glBindFramebuffer(GL_FRAMEBUFFER, g_buffer_);

	// 将当前视野的数据用贴图缓存
	// 位置数据
	glGenTextures(1, &g_position_);
	glBindTexture(GL_TEXTURE_2D, g_position_);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, width, height, 0, GL_RGBA, GL_FLOAT, NULL);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_position_, 0);

	// 法线数据
	glGenTextures(1, &g_normal_);
	glBindTexture(GL_TEXTURE_2D, g_normal_);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32F, width, height, 0, GL_RGBA, GL_FLOAT, NULL);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT1, GL_TEXTURE_2D, g_normal_, 0);

	// 顶点颜色数据
	glGenTextures(1, &g_albedo_);
	glBindTexture(GL_TEXTURE_2D, g_albedo_);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_INT, NULL);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT2, GL_TEXTURE_2D, g_albedo_, 0);

	// orm数据（ao，roughness，metallic）
	glGenTextures(1, &g_orm_);
	glBindTexture(GL_TEXTURE_2D, g_orm_);
	glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_INT, NULL);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
	glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT3, GL_TEXTURE_2D, g_orm_, 0);

	// 生成renderbuffer
	glGenRenderbuffers(1, &g_rbo_);
	glBindRenderbuffer(GL_RENDERBUFFER, g_rbo_);
	glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT, width, height);
	glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, g_rbo_);
	glEnable(GL_DEPTH_TEST);
	
	unsigned int attachments[4] = {GL_COLOR_ATTACHMENT0, GL_COLOR_ATTACHMENT1, GL_COLOR_ATTACHMENT2, GL_COLOR_ATTACHMENT3};
	glDrawBuffers(4, attachments);
	glBindFramebuffer(GL_FRAMEBUFFER, 0);
}
```


可以从上面的代码看到，我们利用了多渲染目标（multiple render targets）可以一次处理并输出到多个缓冲（GL_COLOR_ATTACHMENT0到3）。简化的几何处理着色器示例代码如下：

```glsl
// defer_geometry_pass.frag
layout(location = 0) out vec4 gPosition;
layout(location = 1) out vec4 gNormal;
layout(location = 2) out vec4 gAlbedo;
layout(location = 3) out vec4 gORM;

in vec4 frag_pos;
in vec3 frag_normal;
in vec2 frag_uv;

uniform vec4 albedo;    // color
uniform float metallic;
uniform float roughness;
uniform float ao;

void main()
{
    // 深度信息存储到position贴图的w值中
    gPosition = frag_pos;
    gNormal = vec4(frag_normal, 1.0);
    gAlbedo = albedo;
    gORM = vec4(ao, roughness, metallic, 1.0);
}
```

上方的代码将我们所需要的世界坐标下的顶点坐标信息、法线信息、漫反射颜色和材质信息输出到了四张贴图。带着这四张贴图的信息，我们进入下一个阶段，光照处理阶段。下面是个简化的光照处理着色器代码：

```glsl
void main()
{
    vec3 frag_pos = texture(position_texture, TexCoords).xyz;
    vec3 frag_normal = texture(normal_texture, TexCoords).rgb;
    vec4 env_albedo = texture(albedo_texture, TexCoords);

    vec3 orm = texture(orm_texture, TexCoords).rgb;
    float ao = orm.x;
    float env_roughness = orm.y;
    float env_metallic = orm.z;

    vec3 view = normalize(cam_pos - frag_pos);  //to_view

    vec3 light_color = CalcLight(light_info, frag_normal, view,  frag_pos, material);

    vec3 color = ambient + light_color;
    FragColor = vec4(color, 1.0);
}
```

# 结合延迟和正向渲染

延迟渲染实现起来其实还是比较简单明了的，但是需要注意的是，有些材质并不能通过延迟渲染实现，比如说半透明这种需要进行alpha混合的材质，因此就会出现需要结合延迟渲染和正向渲染的情况。


结合延迟渲染和正向渲染的时候，一般来说是先处理延迟渲染的部分。在处理完延迟渲染后，将延迟渲染的G-buffer的深度缓冲复制到最后输出屏幕的深度缓冲上（我这里最后会继续后处理，所以是会输出到后处理的FrameBuffer上）。如此一来，正向渲染的物体才可以和延迟渲染的场景有正确的深度遮挡结合，否则会出现正向渲染的物体永远在上的情况。实例代码如下所示：

```c++
// 需要将延迟渲染的深度缓冲复制到后面的后处理buffer上
glBindFramebuffer(GL_READ_FRAMEBUFFER, defer_buffer_.g_buffer_);
glBindFramebuffer(GL_DRAW_FRAMEBUFFER, post_process.GetScreenFrameBuffer());
glBlitFramebuffer(0, 0, window_size.x, window_size.y, 0, 0, window_size.x, window_size.y, GL_DEPTH_BUFFER_BIT, 
GL_NEAREST);
```

# 延迟渲染的效能提升
之前提过，延迟渲染最大的好处之一便是能够提升渲染的效率，这里大概做一个粗略的测试。下方是一个包含着1000个人物模型和200个点光源的场景，如果按照正常的正向渲染，这个场景在我的笔记本上的帧率大概在35左右：

![非延迟渲染](no_defer_render.png)

当使用延迟渲染的情况下，该场景的帧率可以提升到170左右：

![延迟渲染](defer_render.png)

当然上方这是个比较极端的场景，实际场景上可能不会有这么复杂的光源，以及模型可能不会像测试场景这样重叠，所以差距可能不会像测试场景那般明显。但是一般来说延迟渲染对渲染场景的性能提升会是比较客观的。

## 基于延迟渲染的延伸
延迟渲染的好处之一不仅仅体现在性能上，由于延迟渲染将很多有用的信息存储下来，基于延迟渲染我们可以实现非常多其他的效果。比如说屏幕空间环境光遮蔽SSAO（如下图）以及屏幕空间反射SSR等等，我计划在后面的文章详细介绍一下。

![SSAO效果](ssao.png)
